//! The background runner: claims queued runs and executes them.
//!
//! [`spawn`] (called from `tasks::spawn_all`) starts one tokio task that
//!
//! 1. at startup, re-queues runs a crash or restart left `running` (once;
//!    a run that was already recovered, or used all its attempts, fails);
//! 2. loops: enqueues due schedules, hourly prunes runs older than 30 days,
//!    then claims queued runs (up to [`RunnerOpts::concurrency`] at a time)
//!    and executes each in its own task; then sleeps until [`wake`] is called
//!    (a trigger queued a run) or the poll interval passes.
//!
//! The work itself is in [`Runner`] methods that tests call directly
//! ([`Runner::drain`] runs everything runnable and returns), so retries,
//! recovery and scheduling are tested without timing games.
//!
//! **Retries.** A transient failure (see [`super::actions`]) re-queues the run
//! with a back-off recorded on the failed log line (`retry_at`); the next
//! attempt resumes at the failed action. After [`MAX_ATTEMPTS`] attempts the
//! run fails. Permanent failures fail at once.

use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use og_core::api::automations::{RunStatus, Trigger};
use tokio::sync::{Notify, Semaphore};

use super::actions::{Executor, RunInput, RunResult};
use super::schedule;
use super::store::{self, RUN_RETENTION_DAYS, RunRow};
use super::triggers::{self, TriggerData};
use super::writer::RecordWriter;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::state::AppState;

/// Attempts per run, the first one included.
pub const MAX_ATTEMPTS: u32 = 3;

static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Tell the runner there is (probably) work. Safe to call from anywhere,
/// including inside a write transaction: the runner claims runs through the
/// writer connection, so it cannot see a run before its transaction commits.
pub fn wake() {
    WAKE.notify_one();
}

#[derive(Debug, Clone)]
pub struct RunnerOpts {
    /// Delay before attempt 2 and attempt 3.
    pub retry_delays: [Duration; 2],
    /// Runs executing at the same time.
    pub concurrency: usize,
    /// Longest sleep between looks at the queue.
    pub poll: Duration,
}

impl Default for RunnerOpts {
    fn default() -> Self {
        RunnerOpts {
            retry_delays: [Duration::from_secs(5), Duration::from_secs(30)],
            concurrency: 4,
            poll: Duration::from_secs(2),
        }
    }
}

/// Start the runner. Call once, from inside the tokio runtime.
pub fn spawn(state: &AppState) {
    let runner = Arc::new(Runner::new(
        state.clone(),
        super::default_record_writer(),
        RunnerOpts::default(),
    ));
    tokio::spawn(runner.run_forever());
}

#[derive(Clone)]
pub struct Runner {
    exec: Arc<Executor>,
    opts: RunnerOpts,
}

impl Runner {
    pub fn new(state: AppState, writer: Arc<dyn RecordWriter>, opts: RunnerOpts) -> Runner {
        Runner {
            exec: Arc::new(Executor::new(state, writer)),
            opts,
        }
    }

    fn state(&self) -> &AppState {
        &self.exec.state
    }

    /// Re-queue (once) or fail runs left `running`. Returns (requeued, failed).
    pub async fn recover(&self) -> AppResult<(usize, usize)> {
        let out = self
            .state()
            .db
            .write(|tx| store::recover_interrupted(tx, now_ms(), MAX_ATTEMPTS))
            .await?;
        if out.0 + out.1 > 0 {
            tracing::warn!(
                requeued = out.0,
                failed = out.1,
                "recovered interrupted automation runs"
            );
        }
        Ok(out)
    }

    /// Queue a run for every enabled schedule whose time has come and move
    /// its `next_run_at` to the next occurrence after `now` (missed
    /// occurrences are not replayed). Returns the number of runs queued.
    pub async fn enqueue_due_schedules(&self, now: i64) -> AppResult<usize> {
        let any_due = self
            .state()
            .db
            .read(move |c| Ok(!store::due_schedules(c, now)?.is_empty()))
            .await?;
        if !any_due {
            return Ok(0);
        }
        self.state()
            .db
            .write(move |tx| {
                let mut queued = 0;
                for a in store::due_schedules(tx, now)? {
                    let Trigger::Schedule { cron, timezone } = &a.trigger else {
                        continue;
                    };
                    let scheduled = a.next_run_at.unwrap_or(now);
                    if triggers::enqueue_schedule(tx, &a.id, scheduled)?.is_some() {
                        queued += 1;
                    }
                    let next = schedule::parse_cron(cron).ok().and_then(|c| {
                        let tz = schedule::parse_timezone(timezone).ok()?;
                        schedule::next_after(&c, tz, now)
                    });
                    if next.is_none() {
                        tracing::warn!(automation = %a.id, "schedule has no next occurrence; it will not run again");
                    }
                    store::set_next_run(tx, &a.id, next)?;
                }
                Ok(queued)
            })
            .await
            .inspect(|n| {
                if *n > 0 {
                    wake();
                }
            })
    }

    /// Claim the oldest runnable run, if any. Always goes through the writer
    /// connection (no read-only pre-check): a run queued inside a write
    /// transaction that has not committed yet is only visible once that
    /// transaction is done, and waiting for the writer is how we wait for it.
    pub async fn claim(&self, now: i64) -> AppResult<Option<RunRow>> {
        self.state()
            .db
            .write(move |tx| store::claim_next(tx, now))
            .await
    }

    /// Run everything that is runnable now, one run after another, and
    /// return how many runs were executed (retries waiting for their
    /// back-off are not runnable and are left queued).
    pub async fn drain(&self) -> AppResult<usize> {
        let mut n = 0;
        while let Some(run) = self.claim(now_ms()).await? {
            process(self.exec.clone(), self.opts.clone(), run).await;
            n += 1;
        }
        Ok(n)
    }

    /// Delete finished runs older than the retention period.
    pub async fn prune(&self, now: i64) -> AppResult<usize> {
        let cutoff = now - RUN_RETENTION_DAYS * 24 * 3600 * 1000;
        self.state()
            .db
            .write(move |tx| store::prune_runs(tx, cutoff))
            .await
    }

    /// The runner loop (never returns).
    pub async fn run_forever(self: Arc<Self>) {
        if let Err(e) = self.recover().await {
            tracing::error!(error = %e, "automation run recovery failed");
        }
        let permits = Arc::new(Semaphore::new(self.opts.concurrency.max(1)));
        let mut last_prune: Option<Instant> = None;
        loop {
            let now = now_ms();
            if let Err(e) = self.enqueue_due_schedules(now).await {
                tracing::error!(error = %e, "could not queue due automation schedules");
            }
            if last_prune.is_none_or(|t| t.elapsed() > Duration::from_secs(3600)) {
                last_prune = Some(Instant::now());
                match self.prune(now).await {
                    Ok(n) if n > 0 => tracing::info!(runs = n, "pruned old automation runs"),
                    Ok(_) => {}
                    Err(e) => tracing::error!(error = %e, "could not prune automation runs"),
                }
            }
            while let Ok(permit) = permits.clone().try_acquire_owned() {
                match self.claim(now_ms()).await {
                    Ok(Some(run)) => {
                        let (exec, opts) = (self.exec.clone(), self.opts.clone());
                        tokio::spawn(async move {
                            process(exec, opts, run).await;
                            drop(permit);
                            // A slot is free again: look for more work.
                            wake();
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::error!(error = %e, "could not claim an automation run");
                        break;
                    }
                }
            }
            tokio::select! {
                _ = WAKE.notified() => {}
                _ = tokio::time::sleep(self.opts.poll) => {}
            }
        }
    }
}

/// Execute one claimed run, surviving panics in the action code.
async fn process(exec: Arc<Executor>, opts: RunnerOpts, run: RunRow) {
    let run_id = run.id;
    let inner = tokio::spawn(process_inner(exec.clone(), opts, run));
    if let Err(e) = inner.await {
        tracing::error!(run = run_id, error = %e, "automation run panicked");
        let _ = exec
            .state
            .db
            .write(move |tx| {
                store::finish(
                    tx,
                    run_id,
                    RunStatus::Failed,
                    Some("internal error while running"),
                    &[],
                    now_ms(),
                )
            })
            .await;
    }
}

async fn process_inner(exec: Arc<Executor>, opts: RunnerOpts, run: RunRow) {
    let run_id = run.id;
    let mut log = run.log.clone();
    let fail = |msg: String, log: Vec<og_core::api::automations::StepLog>| {
        let exec = exec.clone();
        async move {
            let r = exec
                .state
                .db
                .write(move |tx| {
                    store::finish(tx, run_id, RunStatus::Failed, Some(&msg), &log, now_ms())
                })
                .await;
            if let Err(e) = r {
                tracing::error!(run = run_id, error = %e, "could not finish automation run");
            }
        }
    };

    let id = run.automation_id.clone();
    let automation = match exec.state.db.read(move |c| store::get(c, &id)).await {
        Ok(a) => a,
        Err(e) => return fail(format!("automation not available: {e}"), log).await,
    };
    if !automation.enabled {
        return fail("the automation is turned off".into(), log).await;
    }
    let trigger: TriggerData = match serde_json::from_value(run.trigger_data.clone()) {
        Ok(t) => t,
        Err(e) => return fail(format!("unreadable trigger data: {e}"), log).await,
    };

    let result = exec
        .execute(
            &RunInput {
                automation: &automation,
                trigger: &trigger,
                run_id: Some(run_id),
                attempt: run.attempts,
                dry_run: false,
            },
            &mut log,
        )
        .await;

    let outcome = match result {
        RunResult::Succeeded => {
            exec.state
                .db
                .write(move |tx| {
                    store::finish(tx, run_id, RunStatus::Succeeded, None, &log, now_ms())
                })
                .await
        }
        RunResult::Failed { error, transient } if transient && run.attempts < MAX_ATTEMPTS => {
            let delay = opts.retry_delays[(run.attempts.saturating_sub(1) as usize).min(1)];
            let retry_at = now_ms() + delay.as_millis() as i64;
            if let Some(last) = log.last_mut() {
                last.retry_at = Some(retry_at);
            }
            tracing::info!(run = run_id, attempt = run.attempts, %error, "automation run will be retried");
            exec.state
                .db
                .write(move |tx| store::requeue(tx, run_id, &log))
                .await
        }
        RunResult::Failed { error, transient } => {
            let msg = if transient {
                format!(
                    "gave up after {} attempts; last error: {error}",
                    run.attempts
                )
            } else {
                error
            };
            exec.state
                .db
                .write(move |tx| {
                    store::finish(tx, run_id, RunStatus::Failed, Some(&msg), &log, now_ms())
                })
                .await
        }
    };
    if let Err(e) = outcome {
        tracing::error!(run = run_id, error = %e, "could not record automation run result");
    }
}
