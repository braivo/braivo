// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Continue" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      <Button {...args} />
      <Button {...args} variant="secondary" />
      <Button {...args} variant="outline" />
      <Button {...args} variant="ghost" />
      <Button {...args} variant="destructive" />
      <Button {...args} variant="link" />
    </div>
  ),
};

export const Disabled: Story = { args: { disabled: true } };
