// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { ChoiceQuestion } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/ChoiceQuestion",
  component: ChoiceQuestion,
  args: {
    prompt: "Past tense of 'hablar', first person singular?",
    // Shown shuffled: each option keeps its own choice wherever it appears.
    options: [
      { choice: 2, text: "hablaba" },
      { choice: 0, text: "hablo" },
      { choice: 3, text: "hablaré" },
      { choice: 1, text: "hablé" },
    ],
    onChoose: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChoiceQuestion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unanswered: Story = {};

/** Chosen and waiting for the grade. */
export const Pending: Story = { args: { chosen: 1, pending: true } };

/** Chosen, but the grade never came back. */
export const Unconfirmed: Story = { args: { chosen: 1 } };

export const Right: Story = { args: { chosen: 1, answer: 1 } };

export const Wrong: Story = { args: { chosen: 2, answer: 1 } };
