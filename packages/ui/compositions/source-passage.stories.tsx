// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SourcePassage } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/SourcePassage",
  component: SourcePassage,
  args: {
    quote: "Hablé con mi madre ayer. The preterite describes a finished action.",
    title: "Unidad 4: El pretérito",
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SourcePassage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** From a source with a link, such as a video, which opens apart. */
export const Linked: Story = {
  args: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
};

/** Said in a video: the caption names the moment, and the link opens the video there. */
export const AtAMoment: Story = {
  args: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", at: 62.4 },
};

/** On a page of a book: the caption names the page as printed. */
export const OnAPage: Story = {
  args: { page: "12" },
};

/** From pasted text or a file, which has no link to follow. */
export const Unlinked: Story = {};

/** A passage spanning lines keeps its line breaks. */
export const Multiline: Story = {
  args: { quote: "uno — one\ndos — two\ntres — three", title: "Los números" },
};
