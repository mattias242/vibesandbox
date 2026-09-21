/**
 * Vyer som fragment-adresser: `#/` är startsidan, `#/app/<id>` arbetsytan och `#/admin`
 * kontrollrummet. Fragmentet når aldrig servern, så en omladdning kräver inget av den utöver
 * index.html.
 */
export type Route =
  | { readonly view: 'start' }
  | { readonly view: 'app'; readonly appId: string }
  | { readonly view: 'admin' };

const APP_ROUTE = /^#\/app\/([A-Za-z0-9_-]{1,64})$/;

/** Kontrollrummets adress. Exakt den här texten — inget prefix, ingen variant. */
export const ADMIN_HASH = '#/admin';

export function parseRoute(hash: string): Route {
  if (hash === ADMIN_HASH) return { view: 'admin' };
  const match = APP_ROUTE.exec(hash);
  return match?.[1] === undefined ? { view: 'start' } : { view: 'app', appId: match[1] };
}

export function appHash(appId: string): string {
  return `#/app/${appId}`;
}
