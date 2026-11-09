import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Dialog as D } from "radix-ui";
import { CircleAlert } from "lucide-react";
import { useSetupStatus } from "@/auth/useAuth";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { needsPublicHttps } from "@/pages/account/AssistantsSection";
import { AssistantArt, HomeArt, RecordsArt, ViewsArt, WorkspacesArt } from "./illustrations";

interface Screen {
  title: string;
  /** One or two paragraphs. */
  text: ReactNode[];
  Art: () => ReactNode;
}

const strong = "font-semibold text-fg";

// The five steps of APP-3, in the words of the new model. The last one is the optional one.
const SCREENS: Screen[] = [
  {
    title: "Home catches your ideas",
    text: [
      "Home is the first thing you see. Type a thought and press Enter: OpenBase works out where it goes and when it is due, and shows you its guess so you can change it.",
      "Not sure where something belongs? It waits in your Inbox until you do.",
    ],
    Art: HomeArt,
  },
  {
    title: "Collections hold your records",
    text: [
      <>
        A <strong className={strong}>collection</strong> is a list of one kind of thing, like clients or tasks. Each item is a <strong className={strong}>record</strong>.
      </>,
      "Open a record and it becomes a page: a title, a few properties, then room to write. Add a property whenever you want to keep track of another detail.",
    ],
    Art: RecordsArt,
  },
  {
    title: "Views show your collection your way",
    text: [
      "A view is a layout of a collection, like a grid, a board or a calendar, with its own filters and sorting. Type a phrase in the filter bar to narrow it down.",
      <>
        <strong className={strong}>Changes are just for you until you save.</strong> Choose Save as view to keep them for everyone, or Reset to go back.
      </>,
    ],
    Art: ViewsArt,
  },
  {
    title: "Workspaces and folders keep things apart",
    text: [
      "Each workspace has its own collections and its own people, and a color to tell it apart. Inside one, folders group collections that belong together.",
      "You decide who to invite, and you can limit someone to just the folders they need.",
    ],
    Art: WorkspacesArt,
  },
  {
    title: "Connect an assistant, if you like",
    text: ["Everything in OpenBase works by hand. If you want help, connect an AI assistant you trust and ask in plain words. It can only do what you allow, and you can change that at any time."],
    Art: AssistantArt,
  },
];
const LAST = SCREENS.length - 1;
const HTTPS_DOCS = "https://github.com/lukewilson2002/openbase/blob/main/docs/self-hosting.md#2-docker-compose-with-caddy-recommended";

/**
 * The full-screen intro (APP-3): five steps explaining Home, collections and record pages, views and drafts,
 * workspaces and folders, and last the optional assistant. `onFinish` runs for skip, Escape, "I'll do it myself"
 * and "Connect an assistant" alike.
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
          className="ob-fade-in fixed inset-0 z-[60] flex flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-bg"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 md:px-8 md:py-3">
            <Logo className="h-8" />
            <Button variant="ghost" size="md" className="text-muted hover:bg-transparent hover:text-fg" onClick={onFinish}>
              Skip the intro
            </Button>
          </header>

          <main className="flex flex-1 items-start justify-center px-4 pb-6 pt-6 md:items-center md:pb-10">
            <section className="w-full max-w-[36.25rem] rounded-xl border border-line bg-surface shadow-pop">
              <div key={`art-${step}`} className="h-[13.75rem] overflow-hidden rounded-t-xl border-b border-line bg-bg md:h-[16.25rem]">
                <screen.Art />
              </div>

              <div key={`text-${step}`} className="ob-fade-in px-5 pb-1 pt-5 md:px-8 md:pt-6">
                <D.Title asChild>
                  <h1 ref={headingRef} tabIndex={-1} className="mb-2 text-h2 text-fg outline-none md:text-title">
                    {screen.title}
                  </h1>
                </D.Title>
                <D.Description asChild>
                  <div className="flex flex-col gap-2.5 text-read-phone text-muted md:text-read">
                    {screen.text.map((t, i) => (
                      <p key={i}>{t}</p>
                    ))}
                  </div>
                </D.Description>
                {closing && setup && needsPublicHttps(setup.public_url) && (
                  <p role="note" className="mt-3.5 flex items-start gap-2.5 rounded-md bg-warning-soft px-3 py-2.5 text-label text-fg">
                    <Icon icon={CircleAlert} className="mt-px shrink-0" />
                    <span>
                      Claude and ChatGPT on the web need OpenBase at a public https address. Claude Code works from this computer now.{" "}
                      <a href={HTTPS_DOCS} target="_blank" rel="noopener noreferrer" className="font-semibold text-fg underline">
                        Learn more
                      </a>
                    </span>
                  </p>
                )}
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-5 md:px-8 md:pb-6">
                <ol aria-label={`Step ${step + 1} of ${SCREENS.length}`} className="flex items-center gap-2">
                  {SCREENS.map((s, i) => (
                    <li key={s.title} aria-current={i === step ? "step" : undefined} className={cn("h-2 rounded-pill", i === step ? "w-6 bg-primary" : "w-2 bg-line-strong")} />
                  ))}
                </ol>
                {/* Phones: on the closing screen the three buttons drop below the dots, to the right. */}
                <div className={cn("flex flex-wrap items-center justify-end gap-2", closing && "max-md:w-full")}>
                  {closing && (
                    <Button size="lg" onClick={onFinish}>
                      I'll do it myself
                    </Button>
                  )}
                  {step > 0 && (
                    <Button size="lg" onClick={back}>
                      Back
                    </Button>
                  )}
                  <Button key={closing ? "connect" : "next"} variant="primary" size="lg" onClick={closing ? connect : next}>
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
