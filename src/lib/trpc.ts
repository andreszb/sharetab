'use client';

import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/trpc/router';

export const trpc = createTRPCReact<AppRouter>();

/**
 * Output types for every procedure, keyed the same way the client is:
 * `RouterOutputs['friends']['list']`. Deriving page-level types from this
 * beats re-declaring the shape of a query result by hand, which drifts the
 * moment a router changes.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
