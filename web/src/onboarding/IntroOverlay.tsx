import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Dialog as D } from "radix-ui";
import { CircleAlert } from "lucide-react";
import { useSetupStatus } from "@/auth/useAuth";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { needsPublicHttps } from "@/pages/account/AssistantsSection";
import { AssistantArt, BasesArt, TablesArt, TryMe, ViewsArt, WorkspacesArt } from "./illustrations";
import "./intro.css";

interface Screen {
  title: string;
  /** One or two paragraphs. */
  text: ReactNode[];
  Art: () => ReactNode;
}

const strong = "font-semibold text-fg";

const SCREENS: Screen[] = [
  {
    title: "A base holds one project",
    text: ["Think of a base like a spreadsheet file. Inside it are tables. Make a separate base for each project, like planning a wedding or running a side business."],
    Art: BasesArt,
  },
  {
    title: "Tables store your information",
    text: [
      <>
        Each row is a <strong className={strong}>record</strong>, one thing you track. Each column is a <strong className={strong}>field</strong>, a detail about it, like who does
        it or how often.
      </>,
      "Tables are the universal way we keep track of things in computers. They're structured and predictable. Because tables aren't nice to look at, we have other ways to view them.",
    ],
    Art: TablesArt,
  },
  {
    title: "Views show your data in other ways",
    text: [
      "A view is another way to look at a table. Tap Table, Kanban, Calendar, Timeline or Form above to see the chores each way.",
      "Views can have filters, groups, and sort preferences. They don't affect the data, so they're safe to play around with. You can even share views by themselves, so people can see only what you want them to.",
    ],
    Art: ViewsArt,
  },
  {
    title: "Workspaces keep things apart",
    text: ["Each workspace has its own bases and its own people. You decide who to invite, and you can limit someone to just the bases they need."],
    Art: WorkspacesArt,
  },
  {
    title: "Let an assistant manage OpenBase for you",
    text: ["Connect an AI assistant you trust and ask in plain words. It can build tables and update records for you, and it can only do what you are allowed to do."],
    Art: AssistantArt,
  },
];
const STEPS = SCREENS.length - 1;
const LAST = SCREENS.length - 1;
const VIEWS_STEP = 2;
const HTTPS_DOCS = "https://github.com/lukewilson2002/openbase/blob/main/docs/self-hosting.md#2-docker-compose-with-caddy-recommended";

// Footer and header buttons are 44 px tall: the smallest comfortable target for a finger.
const TAP = "h-11 pointer-coarse:h-11";
const BUTTON = cn(TAP, "rounded-[10px] px-[18px] text-[0.9375rem] font-semibold");

/**
 * The full-screen intro: four steps explaining bases, tables, views and workspaces, then a closing
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
          className="ob-fade-in fixed inset-0 z-[60] flex flex-col overflow-y-auto overscroll-contain overflow-x-hidden bg-bg"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 sm:px-7 sm:py-3.5">
            <Logo className="h-8" />
            <Button variant="ghost" className={cn(TAP, "px-2 text-sm font-normal text-muted hover:bg-transparent hover:text-fg")} onClick={onFinish}>
              Skip the intro
            </Button>
          </header>

          <main className="flex flex-1 items-start justify-center px-4 pb-6 pt-9 sm:items-center sm:pb-10">
            <section className="relative w-full max-w-[580px] rounded-[20px] border border-line bg-surface shadow-[0_1px_2px_rgb(15_20_30/0.06),0_12px_40px_rgb(15_20_30/0.1)]">
              {step === VIEWS_STEP && <TryMe />}
              <div key={`art-${step}`} className="h-[220px] overflow-hidden rounded-t-[19px] bg-[color-mix(in_srgb,var(--primary)_8%,var(--surface))] sm:h-[260px]">
                <screen.Art />
              </div>

              <div key={`text-${step}`} className="ob-fade-in px-5 pb-1 pt-5 sm:px-8 sm:pt-[26px]">
                <D.Title asChild>
                  <h1 ref={headingRef} tabIndex={-1} className="mb-2.5 text-[1.375rem] leading-tight tracking-[-0.015em] text-fg outline-none sm:text-[1.625rem]">
                    {screen.title}
                  </h1>
                </D.Title>
                <D.Description asChild>
                  <div className="flex flex-col gap-2.5 text-base leading-relaxed text-muted">
                    {screen.text.map((t, i) => (
                      <p key={i}>{t}</p>
                    ))}
                  </div>
                </D.Description>
                {closing && setup && needsPublicHttps(setup.public_url) && (
                  <p role="note" className="mt-3.5 flex items-start gap-2.5 rounded-[10px] bg-warning-soft px-3 py-2.5 text-sm leading-snug text-fg">
                    <CircleAlert aria-hidden className="mt-px size-[18px] shrink-0" />
                    <span>
                      Claude and ChatGPT on the web need OpenBase at a public https address. Claude Code works from this computer now.{" "}
                      <a href={HTTPS_DOCS} target="_blank" rel="noopener noreferrer" className="font-bold text-fg underline">
                        Learn more
                      </a>
                    </span>
                  </p>
                )}
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-5 sm:px-8 sm:pb-[26px] sm:pt-[22px]">
                {closing ? (
                  <Button className={BUTTON} onClick={onFinish}>
                    I'll do it myself
                  </Button>
                ) : (
                  <ol aria-hidden className="flex items-center gap-2">
                    {Array.from({ length: STEPS }, (_, i) => (
                      <li key={i} className={cn("h-2 rounded-full transition-all duration-300 motion-reduce:transition-none", i === step ? "w-6 bg-primary" : "w-2 bg-line-strong")} />
                    ))}
                  </ol>
                )}
                {/* Phones: on the closing screen Back and Connect drop below "I'll do it myself", to the right. */}
                <div className={cn("flex items-center gap-2.5", closing && "max-[420px]:w-full max-[420px]:justify-end")}>
                  {step > 0 && (
                    <Button className={BUTTON} onClick={back}>
                      Back
                    </Button>
                  )}
                  <Button key={closing ? "connect" : "next"} variant="primary" className={cn(BUTTON, "px-[22px]")} onClick={closing ? connect : next}>
                    {closing ? "Connect an assistant" : "Next"}
                  </Button>
                </div>
              </footer>
            </section>
          </main>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
