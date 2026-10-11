# 0040: Setup asks for the data region, and another region is another installation

Status: accepted (2026-10-11). Amends [ADR 0018](0018-sign-in-and-invitations.md)'s self-serve setup.

## Context

Schools, in the EU especially, ask where their data is stored before they set anything up. An operator may run Braivo once per region, each installation with its own database, files, and accounts, so that a school's data, sign-in included, stays in its region. Braivo's organizations and learning know nothing of regions: one installation stores its data wherever it runs. What setup can do is say where that is, and send someone who wants another region to the installation there. The operator also wants a region to be offered before it opens, so that opening one is a configuration change, not a release.

## Decision

- **An installation may say where it stores data**: `BRAIVO_DATA_REGION`, a two-letter region code (`EU`, `US`, `DE`) that the console names in each person's language (`Intl.DisplayNames`). Codes ISO 3166 leaves to private use name no place and are refused. The operator sets it only if the database and the files are both there; Braivo checks neither.
- **It may list other regions**: `BRAIVO_OTHER_REGIONS`, `US` for a region listed as not yet open, `US=<origin>` for one whose installation sets up organizations at `<origin>/join`, over HTTPS, since people sign in there. Both settings need self-serve setup, the only place they show.
- **Setup asks the region first, defaulting to this installation's**, and only says it when no other is listed. Choosing an open one replaces the form with a link to its `/join`, where they sign in and set up there: nothing is created here, nor carried over. One not yet open is listed and cannot be chosen. It is offered with setup alone, so only to someone owning no organization.
- **The region is not stored on the organization.** Where an organization's data lives is where its installation runs; a column would label rows, not keep them there. Moving one between regions is an export and an import, not a feature.

## Alternatives rejected

- **Only ever a read-only line naming this installation's region.** It cannot show that a region is coming, and opening one would need a release.
- **A region column, and one installation serving every region.** The rows would be labelled, not resident, and accounts would sit in one region.
- **Recording interest in a region not yet open.** A table and a message for a signal the operator can get by asking.

## Consequences

- Opening a region is configuration: its installation, checked by signing in and setting one up there, then `US=<origin>` in each other region's `BRAIVO_OTHER_REGIONS`. Braivo does not check that the origin serves that region.
- Someone with organizations in two regions has an account in each, signed in separately.
- Slugs and learn domains are checked within one installation only; keeping them unique across regions is the operator's.
