// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/SignInForm",
  component: SignInForm,
  args: { step: { step: "email" }, onSubmit: () => {}, onChangeEmail: () => {} },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SignInForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Email: Story = {};

export const WithGoogle: Story = { args: { onContinueWithGoogle: () => {} } };

export const Code: Story = { args: { step: { step: "code", email: "ada@example.com" } } };

export const Resent: Story = {
  args: { step: { step: "code", email: "ada@example.com", sent: 2 } },
};

export const Name: Story = { args: { step: { step: "name" } } };

export const Refused: Story = {
  args: { step: { step: "code", email: "ada@example.com" }, error: "Invalid OTP" },
};

export const Pending: Story = { args: { pending: true } };
