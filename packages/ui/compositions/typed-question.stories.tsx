// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { TypedQuestion } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/TypedQuestion",
  component: TypedQuestion,
  args: {
    prompt: "I am tired: Ich ___ müde.",
    onSubmit: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TypedQuestion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unanswered: Story = {};

/** Sent and waiting for the grade. */
export const Pending: Story = { args: { sent: "bin", pending: true } };

/** Sent, but the grade never came back. */
export const Unconfirmed: Story = { args: { sent: "bin" } };

export const Right: Story = { args: { sent: "bin", outcome: "success" } };

export const Wrong: Story = { args: { sent: "ben", outcome: "failure" } };

/** Locked without a text: the learner asked to be shown the answer. */
export const Revealed: Story = { args: { locked: true, outcome: "failure" } };

/** At a phone's width. */
export const Phone: Story = {
  args: { prompt: "Translate: I would have liked to come, but I was ill." },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};
