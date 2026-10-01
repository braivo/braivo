// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { SourcePassage } from "./source-passage.tsx";

afterEach(cleanup);

describe("a passage from a book", () => {
  test("says which page it is on, and links to the book as it is", () => {
    render(
      <SourcePassage
        quote="Hola significa hello."
        title="Mi primer libro"
        url="https://example.com/libro.pdf"
        page="12"
      />,
    );

    const link = screen.getByRole("link", { name: "Mi primer libro · p. 12" });
    expect(link.getAttribute("href")).toBe("https://example.com/libro.pdf");
  });
});

describe("a passage from a recording", () => {
  test("says when it is said, and opens a YouTube video there", () => {
    render(
      <SourcePassage
        quote="El perro dice guau."
        title="Los animales"
        url="https://www.youtube.com/watch?v=animales"
        at={62.5}
      />,
    );

    const link = screen.getByRole("link", { name: "Los animales · 1:02" });
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=animales&t=62s");
  });

  test.each([
    [
      "an embedded player, which reads start rather than t",
      "https://www.youtube.com/embed/animales?start=5",
      "https://www.youtube.com/embed/animales?start=62",
    ],
    [
      "a privacy-enhanced embed",
      "https://www.youtube-nocookie.com/embed/animales",
      "https://www.youtube-nocookie.com/embed/animales?start=62",
    ],
    ["a short link", "https://youtu.be/animales?t=5", "https://youtu.be/animales?t=62s"],
  ])("opens %s at the moment, replacing any it named", (_label, url, href) => {
    render(<SourcePassage quote="Guau." title="Los animales" url={url} at={62.5} />);

    expect(screen.getByRole("link").getAttribute("href")).toBe(href);
  });

  test("opens any other recording at the moment through a media fragment", () => {
    render(
      <SourcePassage
        quote="Hola."
        title="Lección"
        url="https://example.com/leccion.mp4"
        at={3725}
      />,
    );

    const link = screen.getByRole("link", { name: "Lección · 1:02:05" });
    expect(link.getAttribute("href")).toBe("https://example.com/leccion.mp4#t=3725");
  });

  test("still names the moment when there is no link to open", () => {
    render(<SourcePassage quote="Hola." title="Lección" at={5} />);

    expect(screen.getByText("Lección · 0:05")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
