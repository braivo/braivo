// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useRef } from "react";

/**
 * A signal for the requests a component starts, aborted when it unmounts.
 * Router navigation aborts nothing by itself, so without it the server would
 * pay to finish a slow AI request for nobody.
 *
 *     const abortOnUnmount = useAbortOnUnmount();
 *     await braivo.draftCourse(input, { signal: abortOnUnmount() });
 *
 * Created in the effect rather than in state, since StrictMode runs the
 * cleanup once before remounting.
 */
export function useAbortOnUnmount(): () => AbortSignal | undefined {
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(() => lifetime.current?.signal, []);
}
