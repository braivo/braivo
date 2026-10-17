// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient, type OrganizationSetup } from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@braivo/ui/components/input-group";
import { NativeSelect, NativeSelectOption } from "@braivo/ui/components/native-select";
import { Spinner } from "@braivo/ui/components/spinner";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { flushSync } from "react-dom";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

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
 * address. Created, it opens the organization's page. Laid out as the
 * sign-in form, the step before it: its heading, and touch-sized controls.
 *
 * Where the installation names its region, the data region comes first
 * (ADR 0040), chosen only if other regions are listed: another open region is
 * another installation, so choosing it trades the form for a link there,
 * creating nothing here; one not yet open is listed only.
 */
export function OrganizationSetupForm(props: OrganizationSetup & { braivo: BraivoClient }) {
  const { braivo, domain, dataRegion, otherRegions } = props;
  const router = useRouter();
  const { t, i18n } = useLingui();
  const id = useId();
  const [slug, setSlug] = useState("");
  // Typed in, so the name no longer changes it; emptied, it follows again.
  const [slugTyped, setSlugTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedRegion, setSelectedRegion] = useState(dataRegion);
  // Another region's setup, where choosing it leads instead of creating here.
  const destination = otherRegions.find(({ region }) => region === selectedRegion)?.setupUrl;
  const regionNames = new Intl.DisplayNames([i18n.locale], { type: "region" });
  // Named, so a translator sees what the placeholder holds.
  const selectedRegionName = selectedRegion && regionNames.of(selectedRegion);
  const regionHint = (
    <Trans>
      Your organization's data is stored in this region. You can't change it after setup.
    </Trans>
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (creating) return;
    const form = event.currentTarget;
    const name = form.elements.namedItem("name") as HTMLInputElement;
    if (name.value.trim() === "") {
      name.setCustomValidity(t`Enter your organization's name.`);
      return name.reportValidity();
    }
    if (!SLUG_PATTERN.test(slug)) {
      // A name of no Latin letters or digits makes none: opened to type one.
      flushSync(() => setEditing(true));
      const address = form.elements.namedItem("slug") as HTMLInputElement;
      address.setCustomValidity(
        slug === ""
          ? t`Enter an address of lowercase letters, digits, and single hyphens.`
          : t`Use lowercase letters, digits, and single hyphens between them.`,
      );
      return address.reportValidity();
    }

    setCreating(true);
    setError(undefined);
    let organization;
    try {
      organization = await braivo.setUpOrganization(
        { name: name.value, slug },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
    } catch (thrown) {
      setError(refusal(thrown));
      setCreating(false);
      if (!(thrown instanceof BraivoError)) return;
      // An address refused opens, to be changed.
      if (thrown.code?.startsWith("ADDRESS_")) setEditing(true);
      // Signed out meanwhile (in another tab, say): the guard's check, run
      // again, sends them to sign in, and back here after.
      if (thrown.status === 401) await router.invalidate();
      return;
    }
    // Outside the try: made, it is never reported as not made.
    await router.navigate({
      to: "/$organizationSlug",
      params: { organizationSlug: organization.slug },
    });
    // Owning one now, so no page cached before offers setting one up again.
    await router.invalidate();
  }

  /**
   * Why it was not set up, worded here from Braivo's code, never in its
   * English (ADR 0035). Only a refusal (4xx) proves it was not made; with no
   * answer in time, a server error, or a 201 it could not read, it may have been:
   * reloading lists it, where sending again is refused.
   */
  function refusal(thrown: unknown): string {
    if (!(thrown instanceof BraivoError) || thrown.status < 400 || thrown.status >= 500) {
      return t`Could not confirm the organization was created. Reload this page to check before trying again.`;
    }
    if (thrown.status === 401) return t`You were signed out. Sign in again.`;
    const hostname = `${slug}.${domain}`;
    switch (thrown.code) {
      case "ADDRESS_TAKEN":
        return t`${hostname} is taken. Choose another address.`;
      case "ADDRESS_RESERVED":
        return t`${hostname} is reserved. Choose another address.`;
      case "ADDRESS_INVALID":
        return t`${hostname} is not a valid address. Use lowercase letters, digits, and single hyphens between them.`;
      case "NAME_INVALID":
        return t`Enter a name of at most ${MAX_NAME_LENGTH} characters.`;
      case "ALREADY_OWNER":
        return t`You already own an organization. Reload this page to open it.`;
      default:
        return t`That did not work. Try again.`;
    }
  }

  const placeholder = t({
    message: "your-organization",
    comment: "An example address before a name makes one: lowercase a-z, digits, and hyphens only",
  });
  const address = `${slug || placeholder}.${domain}`;

  return (
    // `data-touch` sizes its controls for touch (`globals.css`).
    <form onSubmit={submit} aria-labelledby={`${id}-heading`} data-touch>
      <div className="mb-8 flex flex-col gap-3">
        <Heading id={`${id}-heading`} className="mb-0 text-4xl tracking-tight">
          <Trans>Set up your organization</Trans>
        </Heading>
        <p className="text-sm text-muted-foreground">
          <Trans>A home for your materials, courses, and learners.</Trans>
        </p>
      </div>
      <FieldSet>
        <FieldGroup>
          {dataRegion !== null &&
            (otherRegions.length === 0 ? (
              // Nothing to choose: shown as the address is, a fact of the form.
              <Field>
                <FieldTitle>
                  <Trans>Data region</Trans>
                </FieldTitle>
                <div className="flex min-h-12 items-center rounded-2xl bg-muted px-3.5 text-sm font-medium wrap-anywhere">
                  {regionNames.of(dataRegion)}
                </div>
                <FieldDescription>{regionHint}</FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor={`${id}-region`}>
                  <Trans>Data region</Trans>
                </FieldLabel>
                <NativeSelect
                  id={`${id}-region`}
                  className="w-full"
                  value={selectedRegion ?? dataRegion}
                  disabled={creating}
                  aria-describedby={`${id}-region-hint`}
                  onChange={(event) => {
                    setError(undefined);
                    setSelectedRegion(event.currentTarget.value);
                  }}
                >
                  <NativeSelectOption value={dataRegion}>
                    {regionNames.of(dataRegion)}
                  </NativeSelectOption>
                  {otherRegions.map(({ region, setupUrl }) => {
                    const regionName = regionNames.of(region);
                    return (
                      <NativeSelectOption key={region} value={region} disabled={setupUrl === null}>
                        {setupUrl === null
                          ? t({
                              message: `${regionName} (coming soon)`,
                              comment: "A data region not open yet, listed and not selectable",
                            })
                          : regionName}
                      </NativeSelectOption>
                    );
                  })}
                </NativeSelect>
                <FieldDescription id={`${id}-region-hint`}>
                  {destination ? (
                    // The select names the region: "in <region>" would need an article for some.
                    <Trans>
                      Organizations in this region are set up on its own site, where you sign in
                      again.
                    </Trans>
                  ) : (
                    regionHint
                  )}
                </FieldDescription>
              </Field>
            ))}
          {/* Hidden, not unmounted, while another region is chosen: what was
              typed, and the address it made, are there on coming back. */}
          <div hidden={destination !== undefined} className="contents">
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                <Trans>Organization name</Trans>
              </FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                required
                maxLength={MAX_NAME_LENGTH}
                autoComplete="organization"
                // An example, never the answer: "e.g." keeps it from reading as one given.
                placeholder={t`e.g. Fernwood Academy`}
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
                <Trans>Your learners see this name. If it's just you, use your own.</Trans>
              </FieldDescription>
            </Field>
            {editing ? (
              <Field>
                <FieldLabel htmlFor={`${id}-slug`}>
                  <Trans>Learners' site</Trans>
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={`${id}-slug`}
                    name="slug"
                    required
                    maxLength={MAX_SLUG_LENGTH}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    // Asks password managers not to offer to fill it, which some
                    // honor only when their user opts in.
                    data-lpignore="true"
                    data-1p-ignore
                    data-bwignore
                    // Rendered on "Edit", so it takes the focus from the button.
                    autoFocus
                    readOnly={creating}
                    value={slug}
                    // The domain too, so the whole address is announced, not just its start.
                    aria-describedby={`${id}-slug-domain ${id}-slug-hint`}
                    onChange={(event) => {
                      event.currentTarget.setCustomValidity("");
                      setError(undefined);
                      setSlug(event.currentTarget.value);
                      setSlugTyped(event.currentTarget.value !== "");
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText id={`${id}-slug-domain`}>.{domain}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                {/* The field and its domain already show the address. */}
                <FieldDescription id={`${id}-slug-hint`}>
                  <Trans>This address cannot be changed later.</Trans>
                </FieldDescription>
              </Field>
            ) : (
              // Permanent, so a row of its own, not a hint; filled and unbordered,
              // so it does not read as a field to type in. A title, not a
              // `<label>`: there is no input until "Edit".
              <Field>
                <FieldTitle>
                  <Trans>Learners' site</Trans>
                </FieldTitle>
                <div className="flex min-h-12 items-center gap-2 rounded-2xl bg-muted ps-3.5 pe-1.5">
                  {/* Muted until the name makes one, so a placeholder never reads as given. */}
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm wrap-anywhere",
                      slug ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {address}
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    // 44px square at least, a touch target's least, within the row's 48.
                    className="h-11 min-w-11 px-2"
                    aria-label={t`Edit learners' site`}
                    // Inert while sending, as the fields are.
                    aria-disabled={creating}
                    onClick={() => !creating && setEditing(true)}
                  >
                    <Trans context="Changes the learners' site address">Edit</Trans>
                  </Button>
                </div>
                <FieldDescription>
                  <Trans>This address cannot be changed later.</Trans>
                </FieldDescription>
              </Field>
            )}
            {error && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Field>
              <Button type="submit" aria-disabled={creating}>
                {creating ? (
                  <>
                    {/* Hidden: "Creating…" already says it. */}
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                    <Trans>Creating…</Trans>
                  </>
                ) : (
                  <>
                    <Trans>Create organization</Trans>
                    <ArrowRightIcon data-icon="inline-end" />
                  </>
                )}
              </Button>
            </Field>
          </div>
          {destination && (
            // Another installation: a page outside the app, reached as one.
            <Field>
              <Button asChild>
                <a href={destination}>
                  <Trans>Go to the {selectedRegionName} site</Trans>
                  <ArrowRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
    </form>
  );
}
