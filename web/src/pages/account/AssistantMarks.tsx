import type { ComponentProps } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/lib/cn";

/*
 * Small brand marks for the AI assistants page, drawn as inline SVG so nothing is fetched and
 * they follow the theme. They are simplified redrawings in the style of the Simple Icons project
 * (https://simpleicons.org, CC0), not copies of the vendors' artwork files:
 *   - Claude: the "spark" of rays in Anthropic's orange (#D97757).
 *   - ChatGPT: the six-petal knot, one colour (currentColor), as the official mark is monochrome.
 * The marks are decorative (aria-hidden); the visible name next to them labels the section.
 */

type MarkProps = Omit<ComponentProps<"svg">, "children">;

// Ray angle (degrees from 12 o'clock) and outer radius: the uneven lengths give the spark its look.
const SPARK_RAYS: [number, number][] = [
  [0, 10.5],
  [31, 9],
  [58, 10.5],
  [88, 9.2],
  [118, 10.4],
  [148, 9],
  [178, 10.6],
  [209, 9.2],
  [238, 10.4],
  [268, 9],
  [298, 10.6],
  [329, 9.2],
];

const RAD = Math.PI / 180;
const round = (n: number) => Math.round(n * 100) / 100;

export function ClaudeMark({ className, ...props }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className={cn("size-5 shrink-0", className)} {...props}>
      <g stroke="#D97757" strokeWidth="2.3" strokeLinecap="round">
        {SPARK_RAYS.map(([deg, outer]) => (
          <line
            key={deg}
            x1={round(12 + 3 * Math.sin(deg * RAD))}
            y1={round(12 - 3 * Math.cos(deg * RAD))}
            x2={round(12 + outer * Math.sin(deg * RAD))}
            y2={round(12 - outer * Math.cos(deg * RAD))}
          />
        ))}
      </g>
    </svg>
  );
}

export function ChatGPTMark({ className, ...props }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className={cn("size-5 shrink-0", className)} {...props}>
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <rect key={deg} x="8.9" y="2.2" width="6.2" height="10" rx="3.1" transform={`rotate(${deg} 12 12) rotate(-32 12 7.2)`} />
        ))}
      </g>
    </svg>
  );
}

/** Not a brand: any other MCP client. */
export function OtherClientsMark({ className }: { className?: string }) {
  return <Blocks aria-hidden className={cn("size-5 shrink-0", className)} />;
}
