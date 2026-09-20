import { useEffect, useState } from 'react';
import type { BuilderMe } from '@vibesandbox/contracts';
import { api, errorMessage } from './client.ts';
import { parseRoute, type Route } from './route.ts';
import { GuideLink, OpenGuideProvider, ServicesGuide } from './ServicesGuide.tsx';
import { StartPage } from './StartPage.tsx';
import { Workspace } from './Workspace.tsx';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<BuilderMe | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    api.me().then(setMe, (error: unknown) => setMeError(errorMessage(error)));
  }, []);

  // Ny vy ⇒ flytta fokus till huvudinnehållet, så att skärmläsare och tangentbord börjar rätt.
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route.view, route.view === 'app' ? route.appId : '']);

  // Guiden går att öppna så snart vi vet vilka tjänster som är påslagna, och bara för den som bygger.
  const canOpenGuide = me !== null && me.canBuild;

  return (
    <OpenGuideProvider open={canOpenGuide ? () => setGuideOpen(true) : null}>
      {/* Inte en vanlig #-länk: fragmentet är vyns adress, och #main skulle byta vy. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Hoppa till innehållet
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            Bygg en app
          </a>
          <span className="topbar-end">
            <GuideLink short />
            {me !== null && <span className="who">Inloggad som {me.displayName}</span>}
          </span>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {meError !== null ? (
          <div className="page">
            <p className="notice notice-error" role="alert">
              {meError}
            </p>
          </div>
        ) : me === null ? (
          <div className="page">
            <p className="muted" aria-live="polite">
              Laddar…
            </p>
          </div>
        ) : !me.canBuild ? (
          <div className="page">
            <h1>Du kan inte bygga appar än</h1>
            <p>Ditt konto har inte behörighet att bygga appar. Hör av dig till den som gav dig tillgång.</p>
          </div>
        ) : route.view === 'app' ? (
          <Workspace key={route.appId} appId={route.appId} />
        ) : (
          <StartPage />
        )}
      </main>
      {me !== null && <ServicesGuide open={guideOpen} services={me.services} onClose={() => setGuideOpen(false)} />}
    </OpenGuideProvider>
  );
}
