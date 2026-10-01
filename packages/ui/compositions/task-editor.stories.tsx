// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { TaskEditor } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/TaskEditor",
  component: TaskEditor,
  args: {
    task: {
      prompt: "¿Qué dice el perro?",
      options: ["guau", "miau", "pío"],
      answer: 0,
      explanation: "Guau is what a dog says in Spanish.",
    },
    onSave: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A proposed task opened for correcting: its words, and which option is right. */
export const Editing: Story = {};

/** A task with no explanation yet, to write one. */
export const WithoutExplanation: Story = {
  args: { task: { prompt: "¿Dos?", options: ["one", "two"], answer: 1 } },
};
