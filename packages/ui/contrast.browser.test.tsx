// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite-plus/client" />
// The theme as the apps load it, compiled by Tailwind (the root config).
import "./styles/globals.css";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser/context";

import { Button } from "./components/button.tsx";
import { Checkbox } from "./components/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/dropdown-menu.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./components/input-group.tsx";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./components/input-otp.tsx";
import { Input } from "./components/input.tsx";
import { Item } from "./components/item.tsx";
import { NativeSelect, NativeSelectOption } from "./components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "./components/radio-group.tsx";
import { Textarea } from "./components/textarea.tsx";
import { ChoiceQuestion } from "./compositions/choice-question.tsx";
import { Heading } from "./compositions/heading.tsx";
import { TypedQuestion } from "./compositions/typed-question.tsx";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

type Rgba = [number, number, number, number];

const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;

/** Any CSS colour, as the browser paints it: sRGB bytes and alpha. */
function paint(color: string): Rgba {
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = "transparent";
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a! / 255];
}

/** `color` over `under`, an opaque colour, as composited. */
function over([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

function contrast(one: Rgba, other: Rgba): number {
  const luminance = (rgb: Rgba) => {
    const [r, g, b] = rgb
      .slice(0, 3)
      .map((byte) => byte / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(one), luminance(other)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** What `element` is drawn on: its nearest ancestor's opaque fill. */
function surface(element: Element): Rgba {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const fill = paint(getComputedStyle(node).backgroundColor);
    if (fill[3] === 1) return fill;
  }
  throw new Error("No opaque surface under the control.");
}

/** Its style once transitions end, so what is read is what stays drawn. */
function settled(element: Element): CSSStyleDeclaration {
  for (const animation of element.getAnimations()) animation.finish();
  return getComputedStyle(element);
}

/** Its border, as drawn over its own fill. */
function edge(element: Element): Rgba {
  const style = settled(element);
  expect(style.borderTopStyle, "a border drawn").not.toBe("none");
  expect(parseFloat(style.borderTopWidth), "a border drawn").toBeGreaterThan(0);
  return over(paint(style.borderTopColor), over(paint(style.backgroundColor), surface(element)));
}

/** Its border, over its own fill, against its surface. */
function borderContrast(element: Element): number {
  return contrast(edge(element), surface(element));
}

/**
 * Its focus outline against what it borders: its surface, and, drawn inside
 * its edge, its own fill too; the lesser.
 */
function outlineContrast(element: Element): number {
  const style = settled(element);
  expect(style.outlineStyle, "an outline drawn").not.toBe("none");
  expect(parseFloat(style.outlineWidth), "an outline drawn").toBeGreaterThan(0);
  const under = surface(element);
  const beside = [under];
  if (parseFloat(style.outlineOffset) < 0) beside.push(over(paint(style.backgroundColor), under));
  return Math.min(
    ...beside.map((color) => contrast(over(paint(style.outlineColor), color), color)),
  );
}

/**
 * Whether it draws a ring, shadcn's focus sign the outline replaces: a shadow
 * with no offset or blur, a spread, a visible colour. Drawn again if Tailwind
 * renames `--tw-ring-shadow`, which `globals.css` clears.
 */
function ringDrawn(element: Element): boolean {
  return settled(element)
    .boxShadow.split(/,(?![^(]*\))/)
    .some((shadow) => {
      const [x, y, blur, spread] = (shadow.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      const visible = paint(shadow.replace(/-?[\d.]+px/g, "").trim())[3] > 0;
      return x === 0 && y === 0 && blur === 0 && (spread ?? 0) > 0 && visible;
    });
}

async function focusByKeyboard(element: HTMLElement) {
  // From the document's start, so `:focus-visible` matches as for a keyboard.
  (document.activeElement as HTMLElement | null)?.blur();
  for (let presses = 0; document.activeElement !== element; presses++) {
    if (presses === 10) throw new Error(`Tab never reaches ${element.outerHTML.slice(0, 80)}`);
    await userEvent.tab();
  }
  expect(element.matches(":focus-visible"), "focus shown as for a keyboard").toBe(true);
}

/** WCAG 1.4.11: what identifies a control, and its focus indicator. */
const LEAST = 3;

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`)!;

/**
 * Each field the apps use, rendered valid or invalid: what draws its
 * boundary, what keyboard focus lands on, and what draws the outline, a
 * group's or a code slot's own for the input inside.
 */
const fields: [
  string,
  (invalid: boolean) => React.ReactNode,
  { bounded: () => HTMLElement; focused: () => HTMLElement; outlined: () => HTMLElement },
][] = [
  [
    "an input",
    (invalid) => <Input aria-label="Name" aria-invalid={invalid} />,
    { bounded: () => slot("input"), focused: () => slot("input"), outlined: () => slot("input") },
  ],
  [
    "a textarea",
    (invalid) => <Textarea aria-label="Name" aria-invalid={invalid} />,
    {
      bounded: () => slot("textarea"),
      focused: () => slot("textarea"),
      outlined: () => slot("textarea"),
    },
  ],
  [
    "a native select",
    (invalid) => (
      <NativeSelect aria-label="Region" aria-invalid={invalid}>
        <NativeSelectOption>EU</NativeSelectOption>
      </NativeSelect>
    ),
    {
      bounded: () => slot("native-select"),
      focused: () => slot("native-select"),
      outlined: () => slot("native-select"),
    },
  ],
  [
    "an input group",
    (invalid) => (
      <InputGroup>
        <InputGroupInput aria-label="Email" aria-invalid={invalid} />
      </InputGroup>
    ),
    {
      bounded: () => slot("input-group"),
      focused: () => slot("input-group-control"),
      outlined: () => slot("input-group"),
    },
  ],
  [
    "the sign-in code's slots",
    (invalid) => (
      <InputOTP maxLength={2} aria-label="Code" aria-invalid={invalid}>
        <InputOTPGroup>
          <InputOTPSlot index={0} aria-invalid={invalid} />
          <InputOTPSlot index={1} aria-invalid={invalid} />
        </InputOTPGroup>
      </InputOTP>
    ),
    {
      bounded: () => slot("input-otp-slot"),
      focused: () => document.querySelector("input")!,
      outlined: () => slot("input-otp-slot"),
    },
  ],
  [
    "a checkbox",
    (invalid) => <Checkbox aria-label="Agree" aria-invalid={invalid} />,
    {
      bounded: () => slot("checkbox"),
      focused: () => slot("checkbox"),
      outlined: () => slot("checkbox"),
    },
  ],
  [
    "a radio button",
    (invalid) => (
      <RadioGroup aria-label="Answer">
        <RadioGroupItem value="a" aria-label="A" aria-invalid={invalid} />
      </RadioGroup>
    ),
    {
      bounded: () => slot("radio-group-item"),
      focused: () => slot("radio-group-item"),
      outlined: () => slot("radio-group-item"),
    },
  ],
];

const variants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;

describe.each(["light", "dark"])("in the neutral theme, %s", (theme) => {
  const setTheme = () => document.documentElement.classList.toggle("dark", theme === "dark");

  test.each(fields)("%s is bounded at 3:1", (_, ui, { bounded }) => {
    setTheme();
    render(ui(false));
    expect(borderContrast(bounded())).toBeGreaterThanOrEqual(LEAST);
  });

  test.each(fields)("%s shows focus at 3:1, invalid too", async (_, ui, { focused, outlined }) => {
    setTheme();
    const { rerender } = render(ui(false));
    const unfocused = edge(outlined());
    await focusByKeyboard(focused());
    expect(outlineContrast(outlined())).toBeGreaterThanOrEqual(LEAST);
    // One line, as Linear's: 1px, over the border it recolours, and no ring.
    const { outlineWidth, outlineOffset, outlineColor } = settled(outlined());
    expect([outlineWidth, outlineOffset]).toEqual(["1px", "-1px"]);
    expect(ringDrawn(outlined())).toBe(false);
    // A group's or a code slot's outline alone, not the input's inside it too.
    if (focused() !== outlined()) expect(settled(focused()).outlineStyle).toBe("none");
    // A 3:1 change from the edge it recolours, so focus shows: grey to grey would not.
    expect(contrast(over(paint(outlineColor), unfocused), unfocused)).toBeGreaterThanOrEqual(LEAST);
    rerender(ui(true));
    expect(outlineContrast(outlined())).toBeGreaterThanOrEqual(LEAST);
    // Outside the red edge, which red over it would not change.
    expect(parseFloat(settled(outlined()).outlineOffset)).toBeGreaterThan(0);
  });

  test.each([
    ["a checkbox", (checked: boolean) => <Checkbox aria-label="Agree" checked={checked} />],
    [
      "a radio button",
      (checked: boolean) => (
        <RadioGroup aria-label="Answer" value={checked ? "a" : ""}>
          <RadioGroupItem value="a" aria-label="A" />
        </RadioGroup>
      ),
    ],
  ])("%s unchecked reads empty, as a field, and checked is filled at 3:1 from it", (_, ui) => {
    setTheme();
    const fill = (checked: boolean) => {
      const { container, unmount } = render(ui(checked));
      const control = container.querySelector<HTMLElement>("[data-state]:not([role=radiogroup])")!;
      const color = over(paint(settled(control).backgroundColor), surface(control));
      unmount();
      return color;
    };
    // Braivo's rule, not WCAG's: unchecked is a field's own fill, as the page's,
    // since a grey one would read as checked; checked unmistakably apart from it.
    const page = paint(getComputedStyle(document.body).backgroundColor);
    expect(contrast(fill(false), page)).toBeLessThan(1.2);
    expect(contrast(fill(true), fill(false))).toBeGreaterThanOrEqual(LEAST);
  });

  test.each(variants)("a %s button shows focus at 3:1", async (variant) => {
    setTheme();
    render(<Button variant={variant}>Continue</Button>);
    const button = screen.getByRole("button");
    await focusByKeyboard(button);
    expect(outlineContrast(button)).toBeGreaterThanOrEqual(LEAST);
    // The main action's fill is no ground for it: outside, as Linear's.
    expect(settled(button).outlineOffset).toBe(variant === "default" ? "2px" : "-1px");
    expect(ringDrawn(button)).toBe(false);
  });

  test.each([
    ["a checkbox", () => <Checkbox aria-label="Agree" defaultChecked />],
    [
      "a radio button",
      () => (
        <RadioGroup aria-label="Answer" defaultValue="a">
          <RadioGroupItem value="a" aria-label="A" />
        </RadioGroup>
      ),
    ],
  ])("%s checked shows focus at 3:1, outside its fill", async (_, ui) => {
    setTheme();
    const { container } = render(ui());
    const control = container.querySelector<HTMLElement>("[data-state]:not([role=radiogroup])")!;
    await focusByKeyboard(control);
    expect(outlineContrast(control)).toBeGreaterThanOrEqual(LEAST);
    expect(settled(control).outlineOffset).toBe("2px");
  });

  // A menu marks its item by a fill, as Linear's, never an outline too.
  test("a menu's item, reached by keyboard, is filled, not outlined", async () => {
    setTheme();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Settings</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.keyboard("{ArrowDown}");
    const item = screen.getByRole("menuitem");
    expect(document.activeElement).toBe(item);
    expect(settled(item).outlineStyle).toBe("none");
    expect(settled(item).backgroundColor).not.toBe(
      settled(slot("dropdown-menu-content")).backgroundColor,
    );
  });

  test("a button in an input group shows its own focus, not the group's", async () => {
    setTheme();
    render(
      <InputGroup>
        <InputGroupInput aria-label="Email" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton>Copy</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
    const button = screen.getByRole("button");
    await focusByKeyboard(button);
    expect(outlineContrast(button)).toBeGreaterThanOrEqual(LEAST);
    expect(settled(slot("input-group")).outlineStyle).toBe("none");
  });

  test("a field on a card is bounded and shows focus at 3:1 there", async () => {
    setTheme();
    render(
      <div style={{ background: "var(--card)" }}>
        <Input aria-label="Name" />
      </div>,
    );
    const field = screen.getByRole("textbox");
    expect(borderContrast(field)).toBeGreaterThanOrEqual(LEAST);
    await focusByKeyboard(field);
    expect(outlineContrast(field)).toBeGreaterThanOrEqual(LEAST);
  });

  // Marks are utilities, which the theme's unlayered rules for fields and
  // outline buttons (globals.css) would otherwise override.
  test("graded answers have distinct colour marks; a correct typed answer matches the correct option", () => {
    setTheme();
    render(
      <I18nProvider i18n={i18n}>
        <ChoiceQuestion
          prompt="Ich ___ müde."
          options={[
            { choice: 1, text: "bin" },
            { choice: 2, text: "bist" },
            { choice: 3, text: "ist" },
          ]}
          chosen={2}
          correctChoice={1}
          onChoose={() => {}}
        />
        <TypedQuestion prompt="Ich ___ müde." sent="bin" outcome="success" onSubmit={() => {}} />
      </I18nProvider>,
    );
    // Border and fill as seen: each over what is under it.
    const drawn = (element: HTMLElement) => {
      const { borderTopColor, backgroundColor } = settled(element);
      const fill = over(paint(backgroundColor), surface(element));
      return { border: over(paint(borderTopColor), fill), fill };
    };
    const option = (text: string) =>
      drawn(screen.getByRole("button", { name: new RegExp(`^${text}\\b`) }));

    // By border and by fill alone, each mark stands apart from no mark and the other.
    const [unmarked, correct, wrong] = [option("ist"), option("bin"), option("bist")];
    for (const part of ["border", "fill"] as const) {
      expect(correct[part], part).not.toEqual(unmarked[part]);
      expect(wrong[part], part).not.toEqual(unmarked[part]);
      expect(wrong[part], part).not.toEqual(correct[part]);
    }
    expect(drawn(screen.getByRole("textbox"))).toEqual(correct);
  });

  test("a graded answer shows focus outside its marked edge", async () => {
    setTheme();
    render(
      <I18nProvider i18n={i18n}>
        <ChoiceQuestion
          prompt="Ich ___ müde."
          options={[
            { choice: 1, text: "bin" },
            { choice: 2, text: "bist" },
          ]}
          chosen={2}
          correctChoice={1}
          onChoose={() => {}}
        />
        <TypedQuestion prompt="Ich ___ müde." sent="bin" outcome="success" onSubmit={() => {}} />
      </I18nProvider>,
    );
    // Locked, they keep focus, for a keyboard learner reading the grade.
    for (const answer of [
      screen.getByRole("button", { name: /^bin\b/ }),
      screen.getByRole("button", { name: /^bist\b/ }),
      screen.getByRole("textbox"),
    ]) {
      await focusByKeyboard(answer);
      expect(outlineContrast(answer)).toBeGreaterThanOrEqual(LEAST);
      // Over the edge, in its colour or the ink, the outline would not show.
      expect(parseFloat(settled(answer).outlineOffset)).toBeGreaterThan(0);
    }
  });

  test("a choice question shows focus at 3:1, clear of its options", async () => {
    setTheme();
    // As the learn app does: Continue, pressed by keyboard, focuses the next question.
    const next = createRef<HTMLDivElement>();
    render(
      <I18nProvider i18n={i18n}>
        <Button onClick={() => next.current?.focus()}>Continue</Button>
        <ChoiceQuestion
          ref={next}
          prompt="Ich ___ müde."
          options={[{ choice: 1, text: "bin" }]}
          onChoose={() => {}}
        />
      </I18nProvider>,
    );
    await focusByKeyboard(screen.getByRole("button", { name: "Continue" }));
    await userEvent.keyboard("{Enter}");

    const question = screen.getByRole("group");
    expect(document.activeElement).toBe(question);
    expect(question.matches(":focus-visible"), "focus shown as for a keyboard").toBe(true);
    expect(outlineContrast(question)).toBeGreaterThanOrEqual(LEAST);
    // The options' borders run along the question's edges: at no offset, the outline sits on them.
    expect(parseFloat(settled(question).outlineOffset)).toBeGreaterThan(0);
  });

  test("a heading given focus shows it at 3:1, clear of its text", async () => {
    setTheme();
    // As the console does: an action pressed by keyboard leaves focus on its section's heading.
    const heading = createRef<HTMLHeadingElement>();
    render(
      <>
        <Button onClick={() => heading.current?.focus()}>Save</Button>
        <Heading ref={heading} tabIndex={-1}>
          Everyday English
        </Heading>
      </>,
    );
    await focusByKeyboard(screen.getByRole("button", { name: "Save" }));
    await userEvent.keyboard("{Enter}");

    const focused = screen.getByRole("heading");
    expect(document.activeElement).toBe(focused);
    expect(focused.matches(":focus-visible"), "focus shown as for a keyboard").toBe(true);
    expect(outlineContrast(focused)).toBeGreaterThanOrEqual(LEAST);
    const style = settled(focused);
    // At no offset, the outline touches the first and last letters.
    expect(parseFloat(style.outlineOffset)).toBeGreaterThan(0);
    // Not `auto`, which steps around the text where its line box overhangs.
    expect(style.outlineStyle).toBe("solid");
  });

  test("a plain link shows focus by its outline at 3:1", async () => {
    setTheme();
    render(<a href="#help">Help</a>);
    await focusByKeyboard(screen.getByRole("link"));
    expect(outlineContrast(screen.getByRole("link"))).toBeGreaterThanOrEqual(LEAST);
  });

  test("a course's link, an item, shows focus at 3:1", async () => {
    setTheme();
    render(
      <Item asChild>
        <a href="#course">Everyday English</a>
      </Item>,
    );
    await focusByKeyboard(screen.getByRole("link"));
    expect(outlineContrast(screen.getByRole("link"))).toBeGreaterThanOrEqual(LEAST);
  });
});

test("in forced colours, an invalid input group's focus is the system's highlight", async () => {
  const forced = (value: string) =>
    cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value }] });
  await forced("active");
  try {
    render(
      <>
        <span style={{ color: "Highlight" }}>Highlight</span>
        <InputGroup>
          <InputGroupInput aria-label="Email" aria-invalid />
        </InputGroup>
      </>,
    );
    await focusByKeyboard(slot("input-group-control"));
    // Not the red, which forced colours repaint as text: a focused field and an invalid one alike.
    expect(settled(slot("input-group-control")).outlineStyle).toBe("none");
    expect(settled(slot("input-group")).outlineColor).toBe(
      getComputedStyle(screen.getByText("Highlight")).color,
    );
  } finally {
    await forced("");
  }
});
