// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from "react";

/** What `promise` resolved to, the last one's kept while a reload reads again. */
export function useSettled<T>(promise: Promise<T> | undefined): T | undefined {
  const [settled, setSettled] = useState<T>();
  useEffect(() => {
    let current = true;
    void promise?.then((value) => current && setSettled(() => value));
    return () => {
      current = false;
    };
  }, [promise]);
  return promise === undefined ? undefined : settled;
}
