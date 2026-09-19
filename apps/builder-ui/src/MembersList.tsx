import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuilderAppMember } from '@vibesandbox/contracts';
import { api } from './client.ts';
import {
  focusAfterRemoval,
  memberLabel,
  membersErrorMessage,
  removeButtonLabel,
  removedMessage,
  removeErrorMessage,
  withoutMember,
} from './members.ts';

/**
 * Vilka som har åtkomst till appen. Borttagning sker i två steg på samma knapp (inga
 * webbläsardialoger): först "Ta bort åtkomst", sedan "Ja, ta bort åtkomst" eller "Avbryt".
 * `refreshKey` ändras av delningsformuläret efter en lyckad inbjudan, så att listan hämtas om.
 */
export function MembersList({ appId, refreshKey }: { appId: string; refreshKey: number }) {
  const [members, setMembers] = useState<readonly BuilderAppMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const list = await api.listMembers(appId);
        if (signal?.aborted) return;
        setMembers(list);
        setLoadError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setLoadError(membersErrorMessage(error));
      }
    },
    [appId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  // Fokus flyttas först när raden verkligen är borta ur DOM:en.
  useEffect(() => {
    if (pendingFocus.current === undefined) return;
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    const button = target === null ? undefined : buttons.current.get(target);
    if (button !== undefined) button.focus();
    else headingRef.current?.focus();
  }, [members]);

  // I bekräftelsesteget hamnar fokus på bekräftelseknappen, som nu bär ett nytt namn.
  useEffect(() => {
    if (confirming !== null) buttons.current.get(confirming)?.focus();
  }, [confirming]);

  async function remove(member: BuilderAppMember) {
    if (removing !== null) return;
    if (confirming !== member.memberId) {
      setConfirming(member.memberId);
      setStatus(null);
      return;
    }
    setRemoving(member.memberId);
    setStatus(null);
    try {
      await api.removeMember(appId, member.memberId);
      const current = members ?? [];
      pendingFocus.current = focusAfterRemoval(current, member.memberId);
      setMembers(withoutMember(current, member.memberId));
      setStatus({ ok: true, message: removedMessage(member) });
    } catch (error) {
      setStatus({ ok: false, message: removeErrorMessage(error) });
    } finally {
      setRemoving(null);
      setConfirming(null);
    }
  }

  function cancel(memberId: string) {
    setConfirming(null);
    buttons.current.get(memberId)?.focus();
  }

  const others = members?.filter((member) => member.role !== 'owner') ?? [];

  return (
    <section className="members" aria-labelledby="members-heading">
      <h3 id="members-heading" ref={headingRef} tabIndex={-1}>
        Har åtkomst
      </h3>
      {loadError !== null && (
        <p className="status-line status-error" role="alert">
          {loadError}{' '}
          <button type="button" className="button button-small" onClick={() => void load()}>
            Försök igen
          </button>
        </p>
      )}
      {members === null && loadError === null && <p className="hint">Hämtar listan…</p>}
      {members !== null && (
        <>
          <ul className="member-list">
            {members.map((member) => (
              <li key={member.memberId} className="member-row">
                <span className="member-email">{memberLabel(member)}</span>
                {member.role !== 'owner' && (
                  <span className="member-actions">
                    <button
                      type="button"
                      ref={(element) => {
                        if (element === null) buttons.current.delete(member.memberId);
                        else buttons.current.set(member.memberId, element);
                      }}
                      className={confirming === member.memberId ? 'button button-small button-danger' : 'button button-small'}
                      aria-label={removeButtonLabel(member, confirming === member.memberId)}
                      // Knappen som tar bort behåller fokus (en inaktiverad knapp tappar det); de andra väntar.
                      disabled={removing !== null && removing !== member.memberId}
                      aria-disabled={removing === member.memberId ? true : undefined}
                      onClick={() => void remove(member)}
                    >
                      {removing === member.memberId
                        ? 'Tar bort…'
                        : confirming === member.memberId
                          ? 'Ja, ta bort åtkomst'
                          : 'Ta bort åtkomst'}
                    </button>
                    {confirming === member.memberId && removing === null && (
                      <button
                        type="button"
                        className="button button-small"
                        aria-label={`Avbryt, behåll åtkomst för ${member.email}`}
                        onClick={() => cancel(member.memberId)}
                      >
                        Avbryt
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {others.length === 0 && <p className="hint">Du har inte delat appen med någon än.</p>}
        </>
      )}
      <p className={status?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
        {status?.message ?? ''}
      </p>
    </section>
  );
}
