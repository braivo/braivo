// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm } from "@braivo/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Compositions/SignInForm",
  component: SignInForm,
  args: { mode: "sign-in", onSubmit: () => {} },
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

export const Default: Story = {};

export const SignUp: Story = {
  args: { mode: "sign-up", switchMode: <a href="#login">Have an account? Sign in</a> },
};

export const Refused: Story = { args: { error: "Invalid email or password" } };

export const Pending: Story = { args: { pending: true } };
