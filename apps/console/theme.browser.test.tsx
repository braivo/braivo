// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "./styles.css";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@braivo/ui/components/sidebar";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

/**
 * The console's theme (ADR 0037), its tokens as Chromium resolves them, in
 * the pairs its pages draw: `@braivo/ui`'s contrast test measures the
 * controls, but in the neutral theme alone.
 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
const probe = document.body.appendChild(document.createElement("div"));

/** Any CSS colour, as painted: sRGB bytes. */
function paint(color: string): [number, number, number] {
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

/** A colour token, as painted. */
function token(name: string): [number, number, number] {
  probe.style.backgroundColor = `var(--${name})`;
  return paint(getComputedStyle(probe).backgroundColor);
}

function luminance(name: string): number {
  const [r, g, b] = token(name)
    .map((byte) => byte / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const grounds = ["background", "sidebar", "card", "popover", "input-background"];

describe.each(["light", "dark"])("%s", (theme) => {
  const setTheme = () => document.documentElement.classList.toggle("dark", theme === "dark");

  test("focus and a field's boundary show at 3:1 on every ground (WCAG 1.4.11)", () => {
    setTheme();
    for (const ground of [...grounds, "accent", "sidebar-accent"]) {
      expect(contrast("ring", ground), `ring on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    for (const ground of ["background", "card", "popover", "input-background"]) {
      expect(contrast("input", ground), `input on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("text reads at 4.5:1 where it is drawn (WCAG 1.4.3)", () => {
    setTheme();
    const pairs = [
      ["foreground", "background"],
      ["foreground", "accent"],
      ["popover-foreground", "popover"],
      ["muted-foreground", "background"],
      ["muted-foreground", "card"],
      ["muted-foreground", "muted"],
      ["sidebar-muted-foreground", "sidebar"],
      ["sidebar-accent-foreground", "sidebar-hover"],
      ["sidebar-accent-foreground", "sidebar-accent"],
    ];
    for (const [text, ground] of pairs) {
      expect(contrast(text!, ground!), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Braivo's rules, as Linear's: a sidebar row hovered is a step from the
  // sidebar, the one shown a step further; a menu's highlighted item shows.
  test("a row shown is filled further than one hovered, and a menu's highlight shows", () => {
    setTheme();
    const away = (name: string) => Math.abs(luminance(name) - luminance("sidebar"));
    expect(away("sidebar-hover")).toBeGreaterThan(0);
    expect(away("sidebar-accent")).toBeGreaterThan(away("sidebar-hover"));
    expect(contrast("accent", "popover")).toBeGreaterThanOrEqual(1.2);
  });

  // shadcn's rows, styled by this stylesheet's rules keyed on their `data-*`:
  // fails if a shadcn update renames one.
  test("a sidebar's rows: soft until hovered or shown, one weight throughout", async () => {
    setTheme();
    render(
      <SidebarProvider>
        <nav>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>Courses</SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive>Sources</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </SidebarProvider>,
    );
    const [idle, shown] = screen.getAllByRole("button");
    const style = (row: HTMLElement) => getComputedStyle(row);
    expect(paint(style(idle!).color)).toEqual(token("sidebar-muted-foreground"));
    expect(paint(style(shown!).backgroundColor)).toEqual(token("sidebar-accent"));
    expect(style(idle!).fontWeight).toBe(style(shown!).fontWeight);
    await userEvent.hover(idle!);
    expect(paint(style(idle!).backgroundColor)).toEqual(token("sidebar-hover"));
    expect(paint(style(idle!).color)).toEqual(token("sidebar-accent-foreground"));
  });
});
