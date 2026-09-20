// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

export const Route = createFileRoute("/_signed-in/")({
  loader: async ({ context }) => {
    const { data, error } = await context.auth.organization.list();
    if (error) throw new Error(error.message ?? "Could not list your organizations.");
    return { organizations: data };
  },
  component: Organizations,
});

function Organizations() {
  const { organizations } = Route.useLoaderData();

  return (
    <>
      <Heading>Organizations</Heading>
      {organizations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No organizations yet</EmptyTitle>
            <EmptyDescription>Create one to publish courses.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="mb-6 list-disc pl-6">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                to="/organizations/$organizationId"
                params={{ organizationId: organization.id }}
                className="underline"
              >
                {organization.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <CreateOrganization />
    </>
  );
}

function CreateOrganization() {
  const { auth } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const id = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    // Every field here is a text input, and a text input's value is a string.
    const data = new FormData(form);
    const field = (name: string) => data.get(name) as string;

    const { error } = await auth.organization.create({
      name: field("name"),
      slug: field("slug"),
    });
    if (error) return setError(error.message ?? "Could not create the organization.");

    setError(undefined);
    form.reset();
    await router.invalidate();
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Organization name</FieldLabel>
          <Input id={`${id}-name`} name="name" required />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
          <Input
            id={`${id}-slug`}
            name="slug"
            required
            pattern="[a-z0-9-]+"
            aria-describedby={`${id}-slug-hint`}
          />
          <FieldDescription id={`${id}-slug-hint`}>
            Lowercase letters, digits, and hyphens.
          </FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <Button type="submit">Create organization</Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
