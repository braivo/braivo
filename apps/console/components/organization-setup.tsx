// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@braivo/ui/components/input-group";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { flushSync } from "react-dom";

/** The server's slug rule (white-label-8), checked here to say so in words. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 63;
const MAX_NAME_LENGTH = 100;

/** Letters NFKD leaves whole, spelled as their nearest ASCII. */
const LETTERS: Record<string, string> = { ł: "l", ø: "o", đ: "d", ß: "ss", æ: "ae", œ: "oe" };

/** An address from a name: "Szkoła Łąka" is `szkola-laka`. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[łøđßæœ]/g, (letter) => LETTERS[letter] ?? "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * Self-serve onboarding (ADR 0018): an organization's name, and the address
 * its learners practise at, `<slug>.<domain>`. Most take the address made
 * from the name, so it is shown, not asked, until edited. A refusal Braivo
 * explains opens it too: past the form's own checks, nearly all are about the
 * address. Created, it opens the organization's page.
 */
export function OrganizationSetup(props: { braivo: BraivoClient; domain: string }) {
  const { braivo, domain } = props;
  const router = useRouter();
  const id = useId();
  const [slug, setSlug] = useState("");
  // Typed in, so the name no longer changes it; emptied, it follows again.
  const [slugTyped, setSlugTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (creating) return;
    const form = event.currentTarget;
    const name = form.elements.namedItem("name") as HTMLInputElement;
    if (name.value.trim() === "") {
      name.setCustomValidity("Enter your organization's name.");
      return name.reportValidity();
    }
    if (!SLUG_PATTERN.test(slug)) {
      // A name of no Latin letters or digits makes none: opened to type one.
      flushSync(() => setEditing(true));
      const address = form.elements.namedItem("slug") as HTMLInputElement;
      address.setCustomValidity(
        slug === ""
          ? "Enter an address of lowercase letters, digits, and single hyphens."
          : "Use lowercase letters, digits, and single hyphens between them.",
      );
      return address.reportValidity();
    }

    setCreating(true);
    setError(undefined);
    let organization;
    try {
      organization = await braivo.setUpOrganization({ name: name.value, slug });
    } catch (thrown) {
      // Braivo's reason when it gave one. Without one it may have been made,
      // its answer lost: reloading lists it, where sending again is refused.
      const reason = thrown instanceof BraivoError ? thrown.reason : undefined;
      if (reason) setEditing(true);
      setError(
        reason ||
          "Could not confirm the organization was created. Reload this page to check before trying again.",
      );
      setCreating(false);
      return;
    }
    // Outside the try: made, it is never reported as not made.
    await router.navigate({
      to: "/$organizationSlug",
      params: { organizationSlug: organization.slug },
    });
  }

  const address = `${slug || "your-name"}.${domain}`;

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`} className="max-w-md">
      <Heading id={`${id}-heading`}>Set up your organization</Heading>
      <MutedText className="mb-6 block">
        A home for your materials, courses, and learners: for a school, a training business, or just
        you.
      </MutedText>
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              name="name"
              required
              maxLength={MAX_NAME_LENGTH}
              autoComplete="organization"
              // The page's one task, so typing starts it.
              autoFocus
              readOnly={creating}
              aria-describedby={`${id}-name-hint`}
              onChange={(event) => {
                const { form, value } = event.currentTarget;
                event.currentTarget.setCustomValidity("");
                if (slugTyped) return;
                // A new address: no complaint about the last one, Braivo's or the form's, holds.
                setError(undefined);
                setSlug(slugOf(value));
                const address = form?.elements.namedItem("slug") as HTMLInputElement | null;
                address?.setCustomValidity("");
              }}
            />
            <FieldDescription id={`${id}-name-hint`}>
              Such as Fernwood Academy. Your learners see it.
            </FieldDescription>
          </Field>
          {editing ? (
            <Field>
              <FieldLabel htmlFor={`${id}-slug`}>Learners' address</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={`${id}-slug`}
                  name="slug"
                  required
                  maxLength={MAX_SLUG_LENGTH}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  // Rendered on "Edit", so it takes the focus from the button.
                  autoFocus
                  readOnly={creating}
                  value={slug}
                  aria-describedby={`${id}-slug-hint`}
                  onChange={(event) => {
                    event.currentTarget.setCustomValidity("");
                    setError(undefined);
                    setSlug(event.currentTarget.value);
                    setSlugTyped(event.currentTarget.value !== "");
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>.{domain}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription id={`${id}-slug-hint`} className="wrap-anywhere">
                Where your learners practise: {address}. It cannot be changed later.
              </FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldDescription className="wrap-anywhere">
                {/* Plain until the name makes one, so a placeholder never reads as given. */}
                Learners practise at{" "}
                {slug ? <strong className="text-foreground">{address}</strong> : address}. It cannot
                be changed later.{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  aria-label="Edit learners' address"
                  // Inert while sending, as the fields are.
                  aria-disabled={creating}
                  onClick={() => !creating && setEditing(true)}
                >
                  Edit
                </Button>
              </FieldDescription>
            </Field>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Field>
            <Button type="submit" aria-disabled={creating}>
              {creating ? "Creating…" : "Create organization"}
            </Button>
          </Field>
        </FieldGroup>
      </FieldSet>
    </form>
  );
}
