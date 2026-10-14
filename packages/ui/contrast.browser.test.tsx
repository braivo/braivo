// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite-plus/client" />
// The theme as the apps load it, compiled by Tailwind (the root config).
import "./styles/globals.css";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { Button } from "./components/button.tsx";
import { Checkbox } from "./components/checkbox.tsx";
import { InputGroup, InputGroupInput } from "./components/input-group.tsx";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./components/input-otp.tsx";
import { Input } from "./components/input.tsx";
import { Item } from "./components/item.tsx";
import { NativeSelect, NativeSelectOption } from "./components/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "./components/radio-group.tsx";
import { Textarea } from "./components/textarea.tsx";

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

/** Its border, over its own fill, against its surface. */
function borderContrast(element: Element): number {
  const style = settled(element);
  expect(style.borderTopStyle, "a border drawn").not.toBe("none");
  expect(parseFloat(style.borderTopWidth), "a border drawn").toBeGreaterThan(0);
  const under = surface(element);
  const fill = over(paint(style.backgroundColor), under);
  return contrast(over(paint(style.borderTopColor), fill), under);
}

/**
 * Its focus ring against its surface: the outermost shadow drawn as a ring
 * (no offset or blur, a spread, a visible colour), read from `box-shadow`.
 */
function ringContrast(element: Element): number {
  const under = surface(element);
  const rings = settled(element)
    // Shadows apart, not the commas inside a colour's parentheses.
    .boxShadow.split(/,(?![^(]*\))/)
    .filter((shadow) => !shadow.includes("inset"))
    .map((shadow) => {
      const [x, y, blur, spread] = (shadow.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      const color = paint(shadow.replace(/-?[\d.]+px/g, "").trim());
      return { color, spread: x === 0 && y === 0 && blur === 0 ? (spread ?? 0) : 0 };
    })
    .filter(({ color, spread }) => spread > 0 && color[3] > 0)
    .sort((one, other) => other.spread - one.spread);
  expect(rings, "a ring drawn").not.toHaveLength(0);
  return contrast(over(rings[0]!.color, under), under);
}

/** Its browser outline against its surface, for what draws no ring. */
function outlineContrast(element: Element): number {
  const style = settled(element);
  expect(style.outlineStyle, "an outline drawn").not.toBe("none");
  expect(parseFloat(style.outlineWidth), "an outline drawn").toBeGreaterThan(0);
  const under = surface(element);
  return contrast(over(paint(style.outlineColor), under), under);
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
 * boundary, what keyboard focus lands on, and what draws the ring, a group's
 * or a code slot's own for the input inside.
 */
const fields: [
  string,
  (invalid: boolean) => React.ReactNode,
  { bounded: () => HTMLElement; focused: () => HTMLElement; ringed: () => HTMLElement },
][] = [
  [
    "an input",
    (invalid) => <Input aria-label="Name" aria-invalid={invalid} />,
    { bounded: () => slot("input"), focused: () => slot("input"), ringed: () => slot("input") },
  ],
  [
    "a textarea",
    (invalid) => <Textarea aria-label="Name" aria-invalid={invalid} />,
    {
      bounded: () => slot("textarea"),
      focused: () => slot("textarea"),
      ringed: () => slot("textarea"),
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
      ringed: () => slot("native-select"),
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
      ringed: () => slot("input-group"),
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
      ringed: () => slot("input-otp-slot"),
    },
  ],
  [
    "a checkbox",
    (invalid) => <Checkbox aria-label="Agree" aria-invalid={invalid} />,
    {
      bounded: () => slot("checkbox"),
      focused: () => slot("checkbox"),
      ringed: () => slot("checkbox"),
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
      ringed: () => slot("radio-group-item"),
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

  test.each(fields)("%s shows focus at 3:1, invalid too", async (_, ui, { focused, ringed }) => {
    setTheme();
    const { rerender } = render(ui(false));
    await focusByKeyboard(focused());
    expect(ringContrast(ringed())).toBeGreaterThanOrEqual(LEAST);
    rerender(ui(true));
    expect(ringContrast(ringed())).toBeGreaterThanOrEqual(LEAST);
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
    await focusByKeyboard(screen.getByRole("button"));
    expect(ringContrast(screen.getByRole("button"))).toBeGreaterThanOrEqual(LEAST);
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
    expect(ringContrast(field)).toBeGreaterThanOrEqual(LEAST);
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
    expect(ringContrast(screen.getByRole("link"))).toBeGreaterThanOrEqual(LEAST);
  });
});
