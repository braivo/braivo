// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { ModeToggle } from "@braivo/ui";
import { Separator } from "@braivo/ui/components/separator";
import { cn } from "@braivo/ui/lib/utils";
import { Trans } from "@lingui/react/macro";
import { GraduationCapIcon } from "lucide-react";
import type { ReactNode } from "react";

import { BraivoLogo } from "./braivo-logo.tsx";
import { LanguageMenu } from "./language-menu.tsx";

/**
 * `/login`'s frame, after shadcn's login-02 block: `aside` from `lg`, then a
 * column with `brand`, the language, and the theme above the form, and
 * `footer` below it. Without `aside`, the column is the page. The form is
 * centred, its width a phone's at most.
 */
export function SignInPage(props: {
  brand?: ReactNode;
  footer?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid min-h-svh", props.aside && "lg:grid-cols-[13fr_12fr]")}>
      {props.aside}
      {/* `min-w-0`, so a long email or hostname wraps rather than widens the page. */}
      <div className="flex min-w-0 flex-col gap-6 p-6 md:p-10">
        <header className="flex items-center justify-between gap-4">
          <div className="min-w-0">{props.brand}</div>
          <div className="flex shrink-0 items-center gap-1">
            <LanguageMenu />
            <ModeToggle />
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">{props.children}</div>
        </div>
        {props.footer && (
          <footer className="text-center text-sm wrap-anywhere text-muted-foreground md:text-left">
            {props.footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * The console's name above its own form: Braivo's logo on a phone, where the
 * story panel is hidden, and the app's name beside the panel, which shows the
 * logo. "Braivo Console" in every language (localization-2).
 */
export function ConsoleBrand() {
  return (
    <>
      <BraivoLogo className="text-3xl lg:hidden" />
      <span className="hidden items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase lg:flex">
        <span className="size-1.5 rounded-full bg-ring" />
        Braivo Console
      </span>
    </>
  );
}

/** Below the form, for a learner who landed on the console rather than their course's site. */
export function LearnerNote() {
  return (
    <>
      <Separator className="my-6" />
      <p className="flex gap-3 text-sm text-muted-foreground">
        <GraduationCapIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          <Trans>
            <strong className="font-medium text-foreground">Here to learn?</strong> Sign in through
            your course's website.
          </Trans>
        </span>
      </p>
    </>
  );
}

/**
 * What Braivo does, for a teacher arriving at the console, beside its own
 * sign-in only: a learn domain's wears no Braivo branding (ADR 0018). From
 * `lg`, where there is room; a phone gets straight to the form. The darker
 * navy in either theme (`--brand-panel-*`), so lime is its accent in both,
 * kept small: the eyebrow and the map, the headline in ink and grey. Its
 * texture stays faint, behind the text and map.
 */
export function ConsoleStory() {
  return (
    <aside className="relative hidden min-w-0 overflow-hidden bg-brand-panel p-10 text-brand-panel-foreground lg:flex xl:px-16">
      {/* A dot grid, fading in toward the map. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(color-mix(in_oklab,var(--brand-panel-muted)_14%,transparent)_1px,transparent_1px)] mask-[linear-gradient(transparent,black_65%)] bg-size-[26px_26px]"
      />
      {/* One column, centred: on a wide screen the panel's width would leave
          left-aligned text a wide empty strip on its right. */}
      <div className="relative mx-auto flex w-full max-w-xl flex-col gap-10">
        <BraivoLogo tone="dark" className="text-3xl" />
        <div className="flex flex-col gap-6">
          <p className="flex items-center gap-3 text-xs font-semibold tracking-widest text-brand-panel-accent uppercase">
            <span aria-hidden="true" className="h-px w-5 bg-current" />
            <Trans>The learning engine behind your courses</Trans>
          </p>
          {/* Not a heading: before the form's in the page, it would be where a
              screen reader's heading navigation lands first. */}
          <p className="font-heading text-[clamp(2.75rem,4vw,4rem)] leading-[1.1] font-bold text-balance">
            <Trans>
              Teach it once.{" "}
              <span className="block text-brand-panel-muted">Tutor every learner.</span>
            </Trans>
          </p>
          <p className="max-w-md text-base/relaxed text-brand-panel-muted">
            <Trans>
              Your materials, turned into practice that knows each learner: what they've mastered,
              what's slipping, and what comes next.
            </Trans>
          </p>
        </div>
        {/* The space the rest leaves: positioned, the map adds nothing to the
            panel's height beyond this minimum, and scales down to fit rather
            than growing the panel. */}
        <div className="relative min-h-24 flex-1">
          <KnowledgeMap className="absolute inset-0 size-full" />
        </div>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-brand-panel-muted">
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-brand-panel-accent" />
            <Trans context="A learner's standing on an objective">Retained</Trans>
          </li>
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full border-[1.5px] border-brand-panel-review" />
            <Trans context="A learner's standing on an objective">Due for review</Trans>
          </li>
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full border-[1.5px] border-dashed border-brand-panel-learning" />
            <Trans context="A learner's standing on an objective">Learning</Trans>
          </li>
        </ul>
      </div>
    </aside>
  );
}

type Standing = "retained" | "due" | "learning";

type Topic = { label: string; standing: Standing; x: number; y: number; width: number };

/**
 * One learner's objectives as a teacher sees them, joined where one builds on
 * another, in the progress spec's standings: told apart by shape as well as
 * colour. Decorative, so hidden; the objectives are an English course's, so
 * stay as they are in every language.
 */
function KnowledgeMap({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 310"
      // Shrunk to fit a short screen, it stays under the text, at the left.
      preserveAspectRatio="xMinYMid meet"
      aria-hidden="true"
      className={cn("overflow-visible", className)}
    >
      <defs>
        <radialGradient id="knowledge-map-halo">
          <stop offset="0" style={{ stopColor: "var(--brand-panel-accent)", stopOpacity: 0.07 }} />
          <stop offset="1" style={{ stopColor: "var(--brand-panel-accent)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <ellipse cx="270" cy="170" rx="240" ry="160" fill="url(#knowledge-map-halo)" />
      <path
        d="M77 233 126 91 282 166 77 233M282 166 435 109"
        fill="none"
        strokeWidth={1.2}
        className="stroke-brand-panel-muted/45"
      />
      <path
        d="m126 91 229-43 80 61-153 57 137 91M282 166 355 48M77 233 419 257"
        fill="none"
        strokeWidth={1.2}
        strokeDasharray="4 6"
        className="stroke-brand-panel-muted/30"
      />
      {TOPICS.map((topic) => (
        <g key={topic.label}>
          <TopicNode {...topic} />
          <rect
            x={topic.x - topic.width / 2}
            y={topic.y + 19}
            width={topic.width}
            height={29}
            rx={14.5}
            className="fill-brand-panel stroke-brand-panel-muted/25"
          />
          <text
            x={topic.x}
            y={topic.y + 38}
            textAnchor="middle"
            className="fill-brand-panel-foreground text-[12px]"
          >
            {topic.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * A topic's mark: filled with a halo when retained (the most central, larger),
 * ringed when due, dashed while learning.
 */
function TopicNode({ x, y, standing, label }: Topic) {
  if (standing === "retained") {
    const central = label === CENTRAL;
    return (
      <>
        <circle cx={x} cy={y} r={central ? 25 : 18} className="fill-brand-panel-accent/10" />
        {central && (
          <circle cx={x} cy={y} r={16} fill="none" className="stroke-brand-panel-accent/40" />
        )}
        <circle cx={x} cy={y} r={central ? 8 : 6} className="fill-brand-panel-accent" />
      </>
    );
  }
  if (standing === "due") {
    return (
      <>
        <circle cx={x} cy={y} r={14} className="fill-brand-panel-review/10" />
        <circle
          cx={x}
          cy={y}
          r={6}
          strokeWidth={2}
          className="fill-brand-panel stroke-brand-panel-review"
        />
      </>
    );
  }
  return (
    <circle
      cx={x}
      cy={y}
      r={6}
      strokeWidth={2}
      strokeDasharray="3 3"
      className="fill-brand-panel stroke-brand-panel-learning"
    />
  );
}

const CENTRAL = "Past simple";

const TOPICS: Topic[] = [
  { label: "Food vocabulary", standing: "retained", x: 126, y: 91, width: 139 },
  { label: "Irregular verbs", standing: "due", x: 355, y: 48, width: 126 },
  { label: "Present perfect", standing: "learning", x: 435, y: 109, width: 132 },
  { label: "Past simple", standing: "retained", x: 282, y: 166, width: 102 },
  { label: "Present simple", standing: "retained", x: 77, y: 233, width: 126 },
  { label: "Phrasal verbs", standing: "due", x: 419, y: 257, width: 116 },
];
