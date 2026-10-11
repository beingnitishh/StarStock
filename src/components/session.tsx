"use client";

import { createContext, useContext, type ReactNode } from "react";
import { isReadOnlyRole, type SessionUser } from "@/lib/types";

/**
 * Makes the signed-in user available to every client component below the app
 * shell, so pages can hide write actions for read-only (Member) accounts.
 */
const SessionContext = createContext<SessionUser | null>(null);

export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

/** The signed-in user, or null when used outside the app shell. */
export function useSession(): SessionUser | null {
  return useContext(SessionContext);
}

/**
 * Whether the current account may change stock, products or warehouses.
 * Fails closed: without a session (or before it resolves) we assume read-only.
 */
export function useCanWrite(): boolean {
  const user = useSession();
  return user ? !isReadOnlyRole(user.role) : false;
}
