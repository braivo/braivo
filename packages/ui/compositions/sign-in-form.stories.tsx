// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/SignInForm",
  component: SignInForm,
  args: {
    step: { step: "email" },
    onSubmit: () => {},
    onResend: () => {},
    onChangeEmail: () => {},
  },
  decorators: [
    // As wide as the apps' sign-in column, and as narrow as a 320px phone allows.
    (Story) => (
      <div className="w-[min(24rem,calc(100vw-2rem))]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SignInForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Email: Story = {};

export const WithGoogle: Story = { args: { onContinueWithGoogle: () => {} } };

export const Titled: Story = { args: { title: "Sign in to Fernwood" } };

export const Code: Story = { args: { step: { step: "code", email: "ada@example.com" } } };

export const Resent: Story = {
  args: { step: { step: "code", email: "ada@example.com", sent: 2 } },
};

/** Within the server's minute: "Send a new code" counts down, locked. */
export const ResendWaiting: Story = {
  args: { step: { step: "code", email: "ada@example.com", resendAt: Date.now() + 42_000 } },
};

/** An email too long for the column, which wraps rather than overflows. */
export const LongEmail: Story = {
  args: {
    step: {
      step: "code",
      email: "aleksandra.wisniewskakowalczyk@szkolapodstawowanr12.fernwood.example",
    },
  },
};

/** A code that can sign in no more: its slots are out of use, and the main button resends. */
export const Spent: Story = {
  args: {
    step: { step: "code", email: "ada@example.com", refused: 1, spent: true },
    error: "That code has expired. Send a new one.",
  },
};

export const Name: Story = { args: { step: { step: "name" } } };

export const Refused: Story = {
  args: {
    step: { step: "code", email: "ada@example.com" },
    error: "That code is not right. Check it, or send a new one.",
  },
};

/** A limit, not a fault: calm, not red. */
export const Waiting: Story = {
  args: { error: "Wait a minute before asking for a code again.", wait: true },
};

export const Pending: Story = { args: { pending: true } };
