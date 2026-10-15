import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Dialog as D } from "radix-ui";
import { TriangleAlert } from "lucide-react";
import { useSetupStatus } from "@/auth/useAuth";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { needsPublicHttps } from "@/pages/account/AssistantsSection";
import { AssistantArt, BasesArt, TablesArt, WorkspacesArt } from "./illustrations";
import "./intro.css";

interface Screen {
  eyebrow: string;
  title: string;
  text: ReactNode;
  Art: () => ReactNode;
}

const SCREENS: Screen[] = [
  {
    eyebrow: "Step 1 of 3 · Bases",
    title: "A base holds one project",
    text: "Think of a base like a spreadsheet file. Inside it are tables, one for each list you keep. Make a separate base for each project, like chores or your side business.",
    Art: BasesArt,
  },
  {
    eyebrow: "Step 2 of 3 · Tables",
    title: "Tables are the lists inside a base",
    text: (
      <>
        Each row is a <strong className="font-semibold text-fg">record</strong>, one thing you track. Each column is a <strong className="font-semibold text-fg">field</strong>, a
        detail about it, like who does it or how often.
      </>
    ),
    Art: TablesArt,
  },
  {
    eyebrow: "Step 3 of 3 · Workspaces",
    title: "Workspaces keep things apart",
    text: "Each workspace has its own bases and its own people. You choose who joins, and their faces show on every base they can open.",
    Art: WorkspacesArt,
  },
  {
    eyebrow: "Optional · Works best for most people",
    title: "Let an assistant do the setup",
    text: "Connect an AI assistant you trust and ask in plain words. It can build tables and update records for you, and it can only do what you are allowed to do.",
    Art: AssistantArt,
  },
];
const STEPS = SCREENS.length - 1;
const LAST = SCREENS.length - 1;

// Footer and header buttons are 44 px tall: the smallest comfortable target for a finger.
const TAP = "h-11";

/**
 * The full-screen intro: three steps explaining bases, tables and workspaces, then a closing
 * screen suggesting an AI assistant. `onFinish` runs for skip, Escape, "I'll do it myself" and
 * "Connect an assistant" alike.
 */
export function IntroOverlay({ onFinish }: { onFinish: () => void }) {
  const navigate = useNavigate();
  const { data: setup } = useSetupStatus();
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const screen = SCREENS[step]!;
  const closing = step === LAST;

  // A screen reader user hears the new heading, and the next Tab starts from the new screen.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const next = () => setStep((s) => Math.min(LAST, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const connect = () => {
    onFinish();
    navigate("/account?tab=assistants");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight" && step < LAST) {
      e.preventDefault();
      next();
    } else if (e.key === "ArrowLeft" && step > 0) {
      e.preventDefault();
      back();
    }
  };

  return (
    <D.Root open onOpenChange={(open) => !open && onFinish()}>
      <D.Portal>
        <D.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            headingRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          className="ob-fade-in fixed inset-0 z-[60] flex flex-col overflow-y-auto overflow-x-hidden bg-bg"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 sm:px-6 sm:py-3">
            <Logo className="h-9" />
            <Button variant="link" className={cn(TAP, "px-2 text-[0.875rem]")} onClick={onFinish}>
              Skip the intro
            </Button>
          </header>

          <main className="flex flex-1 items-start justify-center px-4 pb-6 sm:items-center sm:pb-10">
            <div className="w-full max-w-[580px] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
              <div key={`art-${step}`} className="h-[200px] bg-primary-soft sm:h-[260px] [@media(min-height:760px)]:h-[260px]">
                <screen.Art />
              </div>

              <div key={`text-${step}`} className="ob-fade-in px-5 pb-5 pt-5 sm:px-7 sm:pt-6">
                <p className="text-[0.8125rem] font-medium text-primary">{screen.eyebrow}</p>
                <D.Title asChild>
                  <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-xl leading-tight text-fg outline-none sm:text-2xl">
                    {screen.title}
                  </h1>
                </D.Title>
                <D.Description className="mt-2 text-[0.9375rem] leading-relaxed text-muted">{screen.text}</D.Description>
                {closing && setup && needsPublicHttps(setup.public_url) && (
                  <p role="note" className="mt-4 flex items-start gap-2 rounded-lg border border-[#db871b]/50 bg-warning-soft px-3 py-2.5 text-[0.8125rem] text-fg">
                    <TriangleAlert aria-hidden className="mt-px size-4 shrink-0 text-[#db871b]" />
                    <span>Claude and ChatGPT on the web need OpenBase at a public https address. Claude Code works from this computer now.</span>
                  </p>
                )}
              </div>

              <footer className="border-t border-line px-5 py-3 sm:px-7 sm:py-4">
                {closing ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {/* Phones: Back and "I'll do it myself" share a row above a full-width main button. */}
                    <div className="flex items-center justify-between gap-2 sm:contents">
                      <Button variant="ghost" className={cn(TAP, "-ml-3")} onClick={back}>
                        Back
                      </Button>
                      <Button variant="link" className={cn(TAP, "-mr-2 px-2 text-[0.875rem] sm:ml-auto sm:mr-0")} onClick={onFinish}>
                        I'll do it myself
                      </Button>
                    </div>
                    <Button variant="primary" size="lg" className={cn(TAP, "w-full sm:w-auto")} onClick={connect}>
                      Connect an assistant
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <ol aria-hidden className="flex items-center gap-1.5">
                      {Array.from({ length: STEPS }, (_, i) => (
                        <li key={i} className={cn("h-2 rounded-full transition-all duration-300 motion-reduce:transition-none", i === step ? "w-5 bg-primary" : "w-2 bg-line-strong")} />
                      ))}
                    </ol>
                    <div className="flex items-center gap-2">
                      {step > 0 && (
                        <Button variant="ghost" className={TAP} onClick={back}>
                          Back
                        </Button>
                      )}
                      <Button variant="primary" size="lg" className={cn(TAP, "px-5")} onClick={next}>
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </footer>
            </div>
          </main>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
