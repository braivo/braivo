// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthoredTask, SourcePassage } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Checkbox } from "@braivo/ui/components/checkbox";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/AuthoredTask",
  component: AuthoredTask,
  args: {
    task: {
      kind: "choice",
      prompt: "¿Qué dice el perro?",
      options: ["guau", "miau", "pío"],
      answer: 0,
    },
  },
  decorators: [
    (Story) => (
      <div className="w-xl">
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
    task: {
      kind: "choice",
      prompt: "¿Qué dice el perro?",
      options: ["guau", "miau", "pío"],
      answer: 0,
      explanation: "Guau is what a dog says in Spanish.",
    },
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

/** Written by a tool, waiting for its owner to publish it: in a narrow card, the actions go under the prompt. */
export const Waiting: Story = {
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
  args: {
    task: {
      kind: "choice",
      prompt: "Il segnale raffigurato preannuncia un tratto di strada in cui è vietato il sorpasso",
      options: ["Vero", "Falso"],
      answer: 1,
    },
    status: (
      <span className="flex items-center gap-2">
        <Checkbox aria-label="Select the task" />
        <Badge variant="outline">Waiting</Badge>
      </span>
    ),
    action: (
      <span className="flex items-center gap-2">
        <Button variant="ghost" size="sm">
          Edit
        </Button>
        <Button variant="outline" size="sm">
          Retire
        </Button>
      </span>
    ),
  },
};

/** An action that failed: said first, under the row, by the button that failed. */
export const ActionFailed: Story = {
  args: {
    action: (
      <Button variant="outline" size="sm">
        Retire
      </Button>
    ),
    notice: (
      <Alert variant="destructive">
        <AlertDescription>The task could not be retired. Try again.</AlertDescription>
      </Alert>
    ),
  },
};

/** A typed task: its accepted answers, the first shown to a learner who missed. */
export const Typed: Story = {
  args: {
    task: {
      kind: "typed",
      prompt: "The dog: el ___",
      accepted: ["perro", "can"],
      explanation: "Perro is everyday Spanish; can is literary.",
    },
  },
};
