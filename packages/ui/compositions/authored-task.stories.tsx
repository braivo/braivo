// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthoredTask, SourcePassage } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/AuthoredTask",
  component: AuthoredTask,
  args: {
    prompt: "¿Qué dice el perro?",
    options: ["guau", "miau", "pío"],
    answer: 0,
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AuthoredTask>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As written: the options in order, the correct one marked. */
export const Written: Story = {};

/** Everything a reviewer checks: explanation, the passage it cites, and what to do with it. */
export const UnderReview: Story = {
  args: {
    explanation: "Guau is what a dog says in Spanish.",
    action: (
      <Button variant="outline" size="sm">
        Retire
      </Button>
    ),
    children: (
      <SourcePassage
        quote="El perro dice guau."
        title="Los animales"
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        at={62}
      />
    ),
  },
};
