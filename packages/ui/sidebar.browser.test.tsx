// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite-plus/client" />
// The theme as the apps load it, compiled by Tailwind (the root config).
import "./styles/globals.css";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { Sidebar, SidebarProvider, SidebarTrigger } from "./components/sidebar.tsx";

afterEach(cleanup);

/** Opens the sidebar on the narrowest phone, at `fontSize`: its width. */
async function openedWidth(fontSize: string) {
  await page.viewport(320, 568);
  document.documentElement.style.fontSize = fontSize;
  onTestFinished(() => void document.documentElement.style.removeProperty("font-size"));
  render(
    <SidebarProvider>
      <Sidebar mobileTitle="Navigation" mobileDescription="The organization's pages.">
        Courses
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  return screen.getByRole("dialog").getBoundingClientRect().width;
}

test.each([
  ["16px", 288],
  // 18rem would be 360px; 2rem short of the screen instead.
  ["20px", 280],
])(
  "on the narrowest phone, at a root font of %s, opens the sidebar %ipx wide",
  async (fontSize, width) => {
    expect(await openedWidth(fontSize)).toBe(width);
  },
);
