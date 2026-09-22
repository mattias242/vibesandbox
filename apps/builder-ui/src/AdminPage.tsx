import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ADMIN_TOKEN_WINDOW_DAYS,
  CLASSIFICATIONS,
  CLASSIFICATION_SOURCES,
  type AdminApp,
  type AdminOverview,
  type AdminRegisterEntry,
  type AdminReview,
  type AdminStop,
  type AdminUser,
  type Role,
  type SourceFiles,
} from '@vibesandbox/contracts';
import {
  ADMIN_APP_EDIT_LINK,
  ADMIN_APP_NOTHING_TO_OPEN,
  ADMIN_APP_OPEN_LINK,
  ADMIN_APPS_HEADING,
  ADMIN_DATE_UNKNOWN,
  ADMIN_EMPTY,
  ADMIN_FIGURES_HEADING,
  ADMIN_ID_NOTE,
  ADMIN_INVITE_BUTTON,
  ADMIN_INVITE_EMAIL_LABEL,
  ADMIN_INVITE_HEADING,
  ADMIN_INVITE_NOTE,
  ADMIN_INVITE_ROLE_LABEL,
  ADMIN_INVITE_SENDING,
  ADMIN_LEAD,
  ADMIN_LOADING,
  ADMIN_OWNER_MISSING,
  ADMIN_REGISTER_COLUMNS,
  ADMIN_REGISTER_DECOMMISSIONED_AT,
  ADMIN_REGISTER_DECOMMISSIONED_NOTE,
  ADMIN_REGISTER_EMPTY,
  ADMIN_REGISTER_HEADING,
  ADMIN_REGISTER_LEAD,
  ADMIN_REGISTER_LEVELS_HEADING,
  ADMIN_REGISTER_NEVER_CLASSIFIED,
  ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE,
  ADMIN_REGISTER_SOURCES_HEADING,
  registerStateLabel,
  ADMIN_REVIEWS_COLUMNS,
  ADMIN_REVIEWS_EMPTY,
  ADMIN_REVIEWS_HEADING,
  ADMIN_REVIEWS_LEAD,
  ADMIN_REVIEW_APPROVE_BUTTON,
  ADMIN_REVIEW_APPROVE_NOTE,
  ADMIN_REVIEW_CLOSE_BUTTON,
  ADMIN_REVIEW_CODE_HEADING,
  ADMIN_REVIEW_CODE_NOTE,
  ADMIN_REVIEW_DECIDING,
  ADMIN_REVIEW_NO_FILES,
  ADMIN_REVIEW_OPENING,
  ADMIN_REVIEW_OPEN_BUTTON,
  ADMIN_REVIEW_REASON_LABEL,
  ADMIN_REVIEW_REASON_NOTE,
  ADMIN_REVIEW_REJECT_BUTTON,
  ADMIN_ROLE_BUTTON,
  ADMIN_ROLE_SAVING,
  ADMIN_ROLE_SELECT_LABEL,
  ADMIN_SELF_NOTE,
  ADMIN_STOPS_EMPTY,
  ADMIN_STOPS_HEADING,
  ADMIN_STOPS_PATTERN_NOTE,
  ADMIN_STOPS_PRIVACY_NOTE,
  ADMIN_TITLE,
  ADMIN_TOKENS_NOTE,
  ADMIN_USERS_COLUMNS,
  ADMIN_USERS_HEADING,
  ADMIN_USERS_LEAD,
  CLASSIFICATION_SOURCE_TEXTS,
  CLASSIFICATION_TEXTS,
  REDLINE_TEXTS,
  ROLES,
  ROLE_TEXTS,
  adminErrorMessage,
  classificationSourceText,
  classificationText,
  countRoles,
  countStops,
  inviteErrorMessage,
  invitedMessage,
  reviewApprovedMessage,
  reviewErrorMessage,
  reviewRejectedMessage,
  roleChangedMessage,
  roleErrorMessage,
  roleLabel,
  statusOf,
  validateInviteEmail,
  validateReviewReason,
  withUser,
} from './admin.ts';
import { api } from './client.ts';
import { formatCount, formatUpdated } from './format.ts';
import { appHash } from './route.ts';

/**
 * Kontrollrummet: plattformens administratör ser alla appar utan att gå in på servern, och
 * bestämmer vilka adresser som får logga in.
 *
 * Applistan är ren läsning: den ändrar ingenting i någon app. Varje rad har två länkar — till
 * arbetsytan och till appen som den körs — och båda är genvägar, inte nycklar: den som varken
 * äger appen eller fått den delad möts av samma "finns inte" som en gissad adress ger. Det är
 * också vad `ADMIN_ID_NOTE` säger vid listan, så att ingen tror sig ha fått en behörighet hen
 * inte har.
 *
 * Adresslistan ändrar. Den ändrar först när servern har svarat: knapparna skickar, och det är
 * SERVERNS rad som läggs in i listan. Ett misslyckat anrop lämnar därför vyn precis som den var,
 * med ett besked om varför.
 *
 * Hämtningen och utseendet ligger isär: `AdminPage` hämtar, `AdminView` visar. Då går vyns alla
 * lägen — laddar, tom, full lista, nekad — att pröva utan webbläsare.
 */
export function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [apps, setApps] = useState<readonly AdminApp[] | null>(null);
  const [users, setUsers] = useState<readonly AdminUser[] | null>(null);
  const [stops, setStops] = useState<readonly AdminStop[] | null>(null);
  const [register, setRegister] = useState<readonly AdminRegisterEntry[] | null>(null);
  const [reviews, setReviews] = useState<readonly AdminReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Alla sex anropen tillsammans: vyn visar ingenting förrän den har hela bilden, och ett nekat
    // anrop ska ge ett besked — inte en halv sida. Kön följer med här, men KODEN gör det inte:
    // den hämtas för ett ärende i taget, när någon ber om att få läsa det.
    Promise.all([
      api.adminOverview(),
      api.adminApps(),
      api.adminUsers(),
      api.adminStops(),
      api.adminRegister(),
      api.adminReviews(),
    ]).then(
      ([nextOverview, nextApps, nextUsers, nextStops, nextRegister, nextReviews]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setApps(nextApps);
        setUsers(nextUsers);
        setStops(nextStops);
        setRegister(nextRegister);
        setReviews(nextReviews);
      },
      (caught: unknown) => {
        if (!cancelled) setError(adminErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Efter en ändring är listan sanningen. Siffrorna räknas om ur den, så att panelen och tabellen
   * på samma sida inte säger olika saker.
   */
  function accept(user: AdminUser): { next: readonly AdminUser[]; existed: boolean } {
    const current = users ?? [];
    const existed = current.some((row) => row.userId === user.userId);
    const next = withUser(current, user);
    setUsers(next);
    setOverview((previous) => (previous === null ? previous : { ...previous, users: countRoles(next) }));
    return { next, existed };
  }

  async function invite(email: string, role: Role): Promise<string> {
    const user = await api.adminInvite(email, role);
    const { existed } = accept(user);
    return invitedMessage(user, existed);
  }

  async function setRole(userId: string, role: Role): Promise<string> {
    const user = await api.adminSetRole(userId, role);
    accept(user);
    return roleChangedMessage(user);
  }

  /**
   * Ett avgjort ärende lämnar kön direkt. Det är inte en gissning om vad servern gjorde: raden tas
   * bort först när servern svarat, och svaret ÄR ärendet i sitt nya läge. Kön ska visa det som
   * väntar, och det som är avgjort väntar inte.
   */
  async function decide(reviewId: string, decision: 'godkand' | 'avvisad', reason?: string): Promise<string> {
    const decided = await api.adminDecide(reviewId, decision, reason);
    setReviews((current) => (current ?? []).filter((row) => row.reviewId !== reviewId));
    return decision === 'godkand' ? reviewApprovedMessage(decided) : reviewRejectedMessage(decided);
  }

  return (
    <AdminView
      overview={overview}
      apps={apps}
      users={users}
      stops={stops}
      register={register}
      reviews={reviews}
      error={error}
      onInvite={(email, role) => invite(email, role)}
      onSetRole={(userId, role) => setRole(userId, role)}
      onOpenReview={(reviewId) => api.adminReview(reviewId)}
      onDecide={(reviewId, decision, reason) => decide(reviewId, decision, reason)}
    />
  );
}

export interface AdminViewProps {
  readonly overview: AdminOverview | null;
  readonly apps: readonly AdminApp[] | null;
  readonly users: readonly AdminUser[] | null;
  readonly stops: readonly AdminStop[] | null;
  readonly register: readonly AdminRegisterEntry[] | null;
  readonly reviews: readonly AdminReview[] | null;
  readonly error: string | null;
  /** Löser ut med beskedet att visa; kastar serverns fel, som vyn översätter till klarspråk. */
  readonly onInvite: (email: string, role: Role) => Promise<string>;
  readonly onSetRole: (userId: string, role: Role) => Promise<string>;
  /** Hämtar ETT ärende med dess kod. Anropas först när någon har bett om att få läsa det. */
  readonly onOpenReview: (reviewId: string) => Promise<{ review: AdminReview; files: SourceFiles }>;
  /** Löser ut med beskedet att visa. `reason` krävs för ett nej — servern avvisar annars. */
  readonly onDecide: (reviewId: string, decision: 'godkand' | 'avvisad', reason?: string) => Promise<string>;
}

export function AdminView({
  overview,
  apps,
  users,
  stops,
  register,
  reviews,
  error,
  onInvite,
  onSetRole,
  onOpenReview,
  onDecide,
}: AdminViewProps) {
  return (
    <div className="page page-admin">
      <h1>{ADMIN_TITLE}</h1>
      <p className="hint">{ADMIN_LEAD}</p>

      {error !== null ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : overview === null ||
        apps === null ||
        users === null ||
        stops === null ||
        register === null ||
        reviews === null ? (
        <p className="muted" aria-live="polite">
          {ADMIN_LOADING}
        </p>
      ) : (
        <>
          <section className="admin-block" aria-labelledby="admin-figures-heading">
            <h2 id="admin-figures-heading">{ADMIN_FIGURES_HEADING}</h2>
            <dl className="admin-figures">
              <Figure label="Appar" value={overview.apps} />
              <Figure label="Publicerade" value={overview.published} />
              <Figure label="Väntar på att publiceras" value={overview.drafts} />
              <Figure label={`Bygg senaste ${ADMIN_TOKEN_WINDOW_DAYS} dygnen`} value={overview.tokens.jobs} />
              <Figure label="Bygg som gick fel" value={overview.failedJobs} />
              <Figure label="Tokens in" value={overview.tokens.input} />
              <Figure label="Tokens ut" value={overview.tokens.output} />
              {/* Adresserna som får logga in, per roll. Rollerna med sina svenska namn, samma
                  ord som i listan längre ned — annars ser det ut som två olika saker. */}
              {ROLES.map((role) => (
                <Figure key={role} label={roleLabel(role)} value={overview.users[role]} />
              ))}
            </dl>
            <p className="hint">{ADMIN_TOKENS_NOTE}</p>
          </section>

          <section className="admin-block" aria-labelledby="admin-apps-heading">
            <h2 id="admin-apps-heading">{ADMIN_APPS_HEADING}</h2>
            <p className="hint">{ADMIN_ID_NOTE}</p>
            {apps.length === 0 ? <p className="muted">{ADMIN_EMPTY}</p> : <AppTable apps={apps} />}
          </section>

          <UsersSection users={users} onInvite={onInvite} onSetRole={onSetRole} />

          <StopsSection stops={stops} />

          <RegisterSection register={register} />

          <ReviewsSection reviews={reviews} onOpenReview={onOpenReview} onDecide={onDecide} />
        </>
      )}
    </div>
  );
}

/**
 * Stoppade önskemål. Ren läsning, och medvetet utan länk: ett stopp hör till appen, men
 * kontrollrummet är ingen väg in i den. Önskemålets text finns inte i kontraktet och efterfrågas
 * därför aldrig — den kan bära personuppgifter.
 */
function StopsSection({ stops }: { stops: readonly AdminStop[] }) {
  const counts = countStops(stops);
  return (
    <section className="admin-block" aria-labelledby="admin-stops-heading">
      <h2 id="admin-stops-heading">{ADMIN_STOPS_HEADING}</h2>
      <p className="hint">{ADMIN_STOPS_PRIVACY_NOTE}</p>
      <p className="hint">{ADMIN_STOPS_PATTERN_NOTE}</p>
      {counts.length === 0 ? (
        <p className="muted">{ADMIN_STOPS_EMPTY}</p>
      ) : (
        <table className="admin-table admin-stops">
          <caption className="visually-hidden">Gränser som stoppat önskemål, den vanligaste först</caption>
          <thead>
            <tr>
              <th scope="col">Gräns</th>
              <th scope="col">Vad den betyder</th>
              <th scope="col" className="admin-num">Antal</th>
            </tr>
          </thead>
          <tbody>
            {counts.map(({ category, count }) => (
              <tr key={category}>
                <th scope="row">{REDLINE_TEXTS[category].label}</th>
                <td>{REDLINE_TEXTS[category].explanation}</td>
                <td className="admin-num">{count === 1 ? '1 gång' : `${formatCount(count)} gånger`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * AI-registret. Ren läsning, som applistan och stopplistan: en tillsyn ska kunna se vilka appar
 * som finns, vem som äger dem och hur känsliga uppgifter de hanterar — aldrig gå in i dem. Därför
 * står app-id:t här som förkortad text och aldrig som länk, precis som i applistan.
 *
 * Nivåns och källans ord slås upp genom `classificationText`/`classificationSourceText`, som läser
 * ett okänt värde som den strängaste nivån respektive "det gick inte att avgöra". Vyn faller alltså
 * inte på en rad från en annan version av vår egen kod — den ritar det strängaste svaret.
 */
function RegisterSection({ register }: { register: readonly AdminRegisterEntry[] }) {
  return (
    <section className="admin-block" aria-labelledby="admin-register-heading">
      <h2 id="admin-register-heading">{ADMIN_REGISTER_HEADING}</h2>
      <p className="hint">{ADMIN_REGISTER_LEAD}</p>

      {/* Nivåerna och källorna förklaras en gång, här, i stället för i varje rad: det är en skala
          med fyra steg och tre sätt att hamna på ett steg, och ingetdera går att gissa sig till.
          Kortrutnätet är samma som rollernas — stilmallen hör till en annan del av gränssnittet. */}
      <h3>{ADMIN_REGISTER_LEVELS_HEADING}</h3>
      <dl className="admin-roles admin-levels">
        {CLASSIFICATIONS.map((classification) => (
          <div className="admin-role" key={classification}>
            <dt>{CLASSIFICATION_TEXTS[classification].label}</dt>
            <dd>{CLASSIFICATION_TEXTS[classification].explanation}</dd>
          </div>
        ))}
      </dl>

      <h3>{ADMIN_REGISTER_SOURCES_HEADING}</h3>
      <dl className="admin-roles admin-sources">
        {CLASSIFICATION_SOURCES.map((source) => (
          <div className="admin-role" key={source}>
            <dt>{CLASSIFICATION_SOURCE_TEXTS[source].label}</dt>
            <dd>{CLASSIFICATION_SOURCE_TEXTS[source].explanation}</dd>
          </div>
        ))}
      </dl>

      {/* Varför en rad kan stå på strängaste nivån utan tidpunkt. Utan den här meningen ser den
          raden ut som ett fel i registret, och det är precis vad den inte är. */}
      <p className="hint">{ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE}</p>

      {/* Varför avvecklade appar står kvar. Utan den meningen läses en avvecklad rad som ett bevis
          på att uppgifterna INTE raderades — alltså tvärtemot vad som faktiskt hände. */}
      <p className="hint">{ADMIN_REGISTER_DECOMMISSIONED_NOTE}</p>

      {register.length === 0 ? <p className="muted">{ADMIN_REGISTER_EMPTY}</p> : <RegisterTable register={register} />}
    </section>
  );
}

function RegisterTable({ register }: { register: readonly AdminRegisterEntry[] }) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_REGISTER_HEADING} tabIndex={0}>
      <table className="admin-table admin-register">
        <caption className="visually-hidden">
          Varje app i plattformen med sin känslighetsnivå, den som ändrats senast först
        </caption>
        <thead>
          <tr>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.app}</th>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.owner}</th>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.level}</th>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.source}</th>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.classified}</th>
            <th scope="col">{ADMIN_REGISTER_COLUMNS.state}</th>
          </tr>
        </thead>
        <tbody>
          {register.map((entry, index) => {
            const level = classificationText(entry.classification);
            const source = classificationSourceText(entry.source);
            // En avvecklad rad ska gå att skilja från en levande vid en blick, inte genom att
            // läsa en cell. Klassen sitter på hela raden av just det skälet.
            const gone = entry.decommissionedAt !== null;
            return (
              <tr key={`${entry.appIdPrefix}-${index}`} className={gone ? 'admin-decommissioned' : undefined}>
                <th scope="row" className="admin-app">
                  <span className="admin-app-name">{entry.name}</span>
                  {/* Bara början av adressen — och som text, aldrig som länk. */}
                  <span className="admin-prefix">Börjar med {entry.appIdPrefix}</span>
                </th>
                <td>{entry.ownerEmail ?? <span className="muted">{ADMIN_OWNER_MISSING}</span>}</td>
                <td>
                  <span className="badge">{level.label}</span>
                </td>
                <td>{source.label}</td>
                <td>
                  {entry.classifiedAt === null ? (
                    // Ingen påhittad tidpunkt: appen har aldrig beskrivits, och då finns ingen.
                    <span className="muted">{ADMIN_REGISTER_NEVER_CLASSIFIED}</span>
                  ) : (
                    formatUpdated(entry.classifiedAt) || ADMIN_DATE_UNKNOWN
                  )}
                  {/* Avvecklingsdatumet står i samma cell som klassningens, under den: det är två
                      tidpunkter i samma apps liv, och ordet framför säger vilken av dem det är. */}
                  {entry.decommissionedAt !== null && (
                    <span className="admin-decommissioned-at">
                      {ADMIN_REGISTER_DECOMMISSIONED_AT} {formatUpdated(entry.decommissionedAt) || ADMIN_DATE_UNKNOWN}
                    </span>
                  )}
                </td>
                <td>
                  {/* En avvecklad app visas aldrig som publicerad, hur raden än såg ut när appen
                      levde: adressen slutade svara i samma stund som den avvecklades. */}
                  <span className={gone ? 'badge badge-gone' : entry.published ? 'badge badge-published' : 'badge'}>
                    {registerStateLabel(entry)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Kontrollrummets sjätte del: granskningskön.
 *
 * Skillnaden mot de andra delarna är att den här ytan väntar på ett BESLUT. Tills det är fattat
 * ligger appen stilla och ägaren väntar, så kön står med äldsta ärendet först och nivån ur
 * AI-registret syns innan koden öppnas — en app vars känslighet ingen kunnat avgöra är inte samma
 * sak att släppa ut som en prövad app.
 *
 * Koden hämtas ett ärende i taget, aldrig med kön: att öppna kontrollrummet ska inte innebära att
 * varje apps innehåll läses ur databasen.
 */
function ReviewsSection({
  reviews,
  onOpenReview,
  onDecide,
}: {
  reviews: readonly AdminReview[];
  onOpenReview: AdminViewProps['onOpenReview'];
  onDecide: AdminViewProps['onDecide'];
}) {
  const [open, setOpen] = useState<{ review: AdminReview; files: SourceFiles } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function openCase(reviewId: string) {
    setOpening(reviewId);
    setError(null);
    setResult(null);
    try {
      const opened = await onOpenReview(reviewId);
      // Rutan töms när ett NYTT ärende öppnas: ett skäl hör till den app det skrevs om.
      setReason('');
      setOpen(opened);
    } catch (caught) {
      setOpen(null);
      setError(reviewErrorMessage(caught));
    } finally {
      setOpening(null);
    }
  }

  async function decide(reviewId: string, decision: 'godkand' | 'avvisad') {
    if (deciding) return;
    if (decision === 'avvisad') {
      const checked = validateReviewReason(reason);
      if (!checked.ok) {
        // Skälet prövas innan anropet går iväg: ett nej utan skäl lämnar ägaren utan något att
        // göra åt saken, och det ska granskaren få veta här och inte av ett felmeddelande.
        setError(checked.message);
        return;
      }
      await send(reviewId, 'avvisad', checked.reason);
      return;
    }
    await send(reviewId, 'godkand');
  }

  async function send(reviewId: string, decision: 'godkand' | 'avvisad', text?: string) {
    setDeciding(true);
    setError(null);
    try {
      const message = await onDecide(reviewId, decision, text);
      // Ärendet är avgjort: ytan med koden stängs, så att ingen läser vidare i något som redan
      // gått ut eller redan fått nej.
      setOpen(null);
      setReason('');
      setResult(message);
    } catch (caught) {
      setError(reviewErrorMessage(caught));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <section className="admin-block" aria-labelledby="admin-reviews-heading">
      <h2 id="admin-reviews-heading">{ADMIN_REVIEWS_HEADING}</h2>
      <p className="hint">{ADMIN_REVIEWS_LEAD}</p>

      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <p className="status-line" aria-live="polite">
        {result ?? ''}
      </p>

      {reviews.length === 0 ? (
        <p className="muted">{ADMIN_REVIEWS_EMPTY}</p>
      ) : (
        <ReviewQueue
          reviews={reviews}
          openId={open?.review.reviewId ?? null}
          opening={opening}
          busy={deciding}
          onOpen={(reviewId) => void openCase(reviewId)}
        />
      )}

      {open !== null && (
        <ReviewCase
          review={open.review}
          files={open.files}
          reason={reason}
          deciding={deciding}
          onReasonChange={setReason}
          onDecide={(decision) => void decide(open.review.reviewId, decision)}
          onClose={() => {
            setOpen(null);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Kön. Ren läsning så när som på knappen som öppnar ett ärende — och knappen leder inte in i
 * appen, den hämtar koden hit. Appens namn är radens rubrik, och bara början av app-id:t står
 * där, precis som i applistan och registret.
 */
function ReviewQueue({
  reviews,
  openId,
  opening,
  busy,
  onOpen,
}: {
  reviews: readonly AdminReview[];
  openId: string | null;
  opening: string | null;
  busy: boolean;
  onOpen: (reviewId: string) => void;
}) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_REVIEWS_HEADING} tabIndex={0}>
      <table className="admin-table admin-reviews">
        <caption className="visually-hidden">Appar som väntar på granskning, den som begärdes först överst</caption>
        <thead>
          <tr>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.app}</th>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.owner}</th>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.requested}</th>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.level}</th>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.source}</th>
            <th scope="col">{ADMIN_REVIEWS_COLUMNS.open}</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => {
            const level = classificationText(review.classification);
            const source = classificationSourceText(review.classificationSource);
            return (
              <tr key={review.reviewId}>
                <th scope="row" className="admin-app">
                  <span className="admin-app-name">{review.name}</span>
                  {/* Bara början av adressen — och som text, aldrig som länk. */}
                  <span className="admin-prefix">Börjar med {review.appIdPrefix}</span>
                </th>
                <td>{review.ownerEmail ?? <span className="muted">{ADMIN_OWNER_MISSING}</span>}</td>
                <td>{formatUpdated(review.requestedAt) || ADMIN_DATE_UNKNOWN}</td>
                <td>
                  <span className="badge">{level.label}</span>
                </td>
                {/* Källan står i klartext i varje rad: skillnaden mellan en gjord bedömning och
                    en som inte gick att göra är hela skälet till att nivån visas här. */}
                <td>{source.label}</td>
                <td>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy || opening !== null || review.reviewId === openId}
                    onClick={() => onOpen(review.reviewId)}
                  >
                    {opening === review.reviewId ? ADMIN_REVIEW_OPENING : ADMIN_REVIEW_OPEN_BUTTON}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Ett öppnat ärende, med appens källkod.
 *
 * Det här är den ENDA platsen i hela kontrollrummet där innehållet i någons app visas. Applistan,
 * stopplistan och registret svarar alla på att appar finns — aldrig på vad som står i dem, just
 * därför att ett önskemål eller en rad kod kan bära personuppgifter. Undantaget är inte en glipa
 * i den regeln, det är vad granskningen ÄR: en människa läser koden och avgör om den får gå ut.
 * Därför står den också här, i kön där beslutet fattas, och ingen annanstans.
 *
 * Koden visas som text. Den körs aldrig, och inget av den tolkas som märkspråk — React skriver ut
 * den som innehåll, inte som HTML.
 */
export function ReviewCase({
  review,
  files,
  reason,
  deciding,
  onReasonChange,
  onDecide,
  onClose,
}: {
  review: AdminReview;
  files: SourceFiles;
  reason: string;
  deciding: boolean;
  onReasonChange: (value: string) => void;
  onDecide: (decision: 'godkand' | 'avvisad') => void;
  onClose: () => void;
}) {
  const paths = Object.keys(files).sort();
  const level = classificationText(review.classification);
  const source = classificationSourceText(review.classificationSource);
  return (
    <div className="admin-review-case admin-block">
      <h3>{ADMIN_REVIEW_CODE_HEADING}</h3>
      <p>
        <span className="admin-app-name">{review.name}</span> <span className="badge">{level.label}</span>{' '}
        <span className="admin-note">{source.label}</span>
      </p>
      <p className="hint">{ADMIN_REVIEW_CODE_NOTE}</p>

      {paths.length === 0 ? (
        <p className="notice notice-error" role="alert">
          {ADMIN_REVIEW_NO_FILES}
        </p>
      ) : (
        <>
          {paths.map((path) => (
            <details className="job-details" key={path} open>
              <summary>{path}</summary>
              <pre>
                <code>{files[path]}</code>
              </pre>
            </details>
          ))}

          <ReviewDecision
            reason={reason}
            deciding={deciding}
            onReasonChange={onReasonChange}
            onDecide={onDecide}
          />
        </>
      )}

      <div className="form-actions">
        <button type="button" className="button button-small" onClick={onClose} disabled={deciding}>
          {ADMIN_REVIEW_CLOSE_BUTTON}
        </button>
      </div>
    </div>
  );
}

/**
 * Besluten. Skälet står ovanför knapparna och upplysningen om att ägaren får det ordagrant står
 * ovanför rutan: den som skriver ska veta vart texten tar vägen INNAN hon skriver den, inte efter
 * att hon skickat. Av samma skäl står det vid godkännandet att appen publiceras direkt.
 */
function ReviewDecision({
  reason,
  deciding,
  onReasonChange,
  onDecide,
}: {
  reason: string;
  deciding: boolean;
  onReasonChange: (value: string) => void;
  onDecide: (decision: 'godkand' | 'avvisad') => void;
}) {
  const reasonId = useId();
  const noteId = useId();
  return (
    <form
      className="admin-review-decision"
      onSubmit={(event) => {
        event.preventDefault();
        onDecide('avvisad');
      }}
    >
      <label className="field-label" htmlFor={reasonId}>
        {ADMIN_REVIEW_REASON_LABEL}
      </label>
      <p id={noteId} className="hint">
        {ADMIN_REVIEW_REASON_NOTE}
      </p>
      <textarea
        id={reasonId}
        className="wish-text"
        rows={3}
        value={reason}
        aria-describedby={noteId}
        disabled={deciding}
        onChange={(event) => onReasonChange(event.target.value)}
      />
      <p className="hint">{ADMIN_REVIEW_APPROVE_NOTE}</p>
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={deciding}
          onClick={() => onDecide('godkand')}
        >
          {deciding ? ADMIN_REVIEW_DECIDING : ADMIN_REVIEW_APPROVE_BUTTON}
        </button>
        <button type="submit" className="button" disabled={deciding}>
          {deciding ? ADMIN_REVIEW_DECIDING : ADMIN_REVIEW_REJECT_BUTTON}
        </button>
      </div>
    </form>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-figure">
      <dt>{label}</dt>
      <dd>{formatCount(value)}</dd>
    </div>
  );
}

/**
 * Riktiga tabellelement, inte rutor som ser ut som en tabell: appens namn är radens rubrik
 * (`th scope="row"`), så att en skärmläsare kan säga vilken app en cell hör till.
 */
function AppTable({ apps }: { apps: readonly AdminApp[] }) {
  return (
    // På smal skärm rullar tabellen i sidled i stället för att kolumnerna knycklas ihop.
    // tabIndex + role gör att den som bara har tangentbord kan rulla den, och att den får ett namn.
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_APPS_HEADING} tabIndex={0}>
      <table className="admin-table">
        <caption className="visually-hidden">Alla appar i plattformen, den som ändrats senast först</caption>
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Ägare</th>
            <th scope="col">Läge</th>
            <th scope="col" className="admin-num">
              Personer
            </th>
            <th scope="col" className="admin-num">
              Tokens in / ut
            </th>
            <th scope="col">Senast ändrad</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app, index) => {
            const status = statusOf(app);
            return (
              <tr key={`${app.appId}-${index}`}>
                <th scope="row" className="admin-app">
                  <span className="admin-app-name">{app.name}</span>
                  <span className="admin-prefix">Börjar med {app.appIdPrefix}</span>
                  {/* Två vägar in, och båda är genvägar: den som inte äger eller fått appen delad
                      möts av samma "finns inte" som förut. Appens adress öppnas i en egen flik —
                      den ligger på en annan värd, och kontrollrummet ska stå kvar bakom. */}
                  <span className="admin-app-links">
                    <a href={appHash(app.appId)}>{ADMIN_APP_EDIT_LINK}</a>
                    {app.appUrl === null ? (
                      <span className="muted">{ADMIN_APP_NOTHING_TO_OPEN}</span>
                    ) : (
                      <a href={app.appUrl} target="_blank" rel="noreferrer">
                        {ADMIN_APP_OPEN_LINK}
                      </a>
                    )}
                  </span>
                </th>
                <td>{app.ownerEmail ?? <span className="muted">{ADMIN_OWNER_MISSING}</span>}</td>
                <td>
                  <span className={status.published ? 'badge badge-published' : 'badge'}>{status.label}</span>
                  {status.note !== null && <span className="admin-note">{status.note}</span>}
                </td>
                <td className="admin-num">{formatCount(app.members)}</td>
                <td className="admin-num">
                  {formatCount(app.tokens.input)} / {formatCount(app.tokens.output)}
                </td>
                <td>{formatUpdated(app.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Kontrollrummets tredje del: vilka som får logga in, och med vilken roll. */
function UsersSection({
  users,
  onInvite,
  onSetRole,
}: {
  users: readonly AdminUser[];
  onInvite: AdminViewProps['onInvite'];
  onSetRole: AdminViewProps['onSetRole'];
}) {
  return (
    <section className="admin-block" aria-labelledby="admin-users-heading">
      <h2 id="admin-users-heading">{ADMIN_USERS_HEADING}</h2>
      <p className="hint">{ADMIN_USERS_LEAD}</p>

      {/* Vad de tre rollerna får göra. Sagt en gång, här — skillnaden mellan dem är inte
          självklar, och den som väljer roll åt en kollega behöver veta det innan hen väljer. */}
      <dl className="admin-roles">
        {ROLES.map((role) => (
          <div className="admin-role" key={role}>
            <dt>{ROLE_TEXTS[role].label}</dt>
            <dd>{ROLE_TEXTS[role].explanation}</dd>
          </div>
        ))}
      </dl>

      <InviteForm onInvite={onInvite} />
      <UserTable users={users} onSetRole={onSetRole} />
    </section>
  );
}

function InviteForm({ onInvite }: { onInvite: AdminViewProps['onInvite'] }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('builder');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const emailId = useId();
  const roleId = useId();
  const resultId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const checked = validateInviteEmail(email);
    if (!checked.ok) {
      setResult({ ok: false, message: checked.message });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const message = await onInvite(checked.email, role);
      // Rutan töms först nu: går anropet fel står adressen kvar, och går att skicka om.
      setEmail('');
      setResult({ ok: true, message });
    } catch (caught) {
      setResult({ ok: false, message: inviteErrorMessage(caught) });
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="admin-invite" onSubmit={(event) => void submit(event)} noValidate>
      <h3>{ADMIN_INVITE_HEADING}</h3>
      <p className="hint">{ADMIN_INVITE_NOTE}</p>
      <div className="admin-invite-row">
        <div className="admin-field">
          <label className="field-label" htmlFor={emailId}>
            {ADMIN_INVITE_EMAIL_LABEL}
          </label>
          <input
            id={emailId}
            className="input"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={result !== null && !result.ok}
            aria-describedby={resultId}
            disabled={sending}
          />
        </div>
        <div className="admin-field admin-field-role">
          <label className="field-label" htmlFor={roleId}>
            {ADMIN_INVITE_ROLE_LABEL}
          </label>
          <select
            id={roleId}
            className="input admin-select"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={sending}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? ADMIN_INVITE_SENDING : ADMIN_INVITE_BUTTON}
        </button>
      </div>
      <p id={resultId} className={result?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
        {result?.message ?? ''}
      </p>
    </form>
  );
}

/**
 * Adressen är radens rubrik (`th scope="row"`), så att en skärmläsare kan knyta varje cell till
 * rätt person. Adressen står BARA där och i beskedet efter en ändring — aldrig i ett `aria-label`,
 * en `title` eller ett `id`, eftersom sådant följer med i uppläsningen utan att någon bett om det.
 */
function UserTable({ users, onSetRole }: { users: readonly AdminUser[]; onSetRole: AdminViewProps['onSetRole'] }) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_USERS_HEADING} tabIndex={0}>
      <table className="admin-table">
        <caption className="visually-hidden">Alla adresser som får logga in i plattformen</caption>
        <thead>
          <tr>
            <th scope="col">{ADMIN_USERS_COLUMNS.email}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.role}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.created}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.change}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.userId}>
              <th scope="row" className="admin-user-email">
                {user.email}
              </th>
              <td>
                <span className="badge">{roleLabel(user.role)}</span>
              </td>
              <td>{user.createdAt === null ? ADMIN_DATE_UNKNOWN : formatUpdated(user.createdAt)}</td>
              <td>
                {user.self ? (
                  // Ingen knapp, inte ens en inaktiverad: en knapp som bara kan misslyckas är ett
                  // löfte vyn inte kan hålla. I stället står det varför raden ser annorlunda ut.
                  <p className="admin-self-note">{ADMIN_SELF_NOTE}</p>
                ) : (
                  <RoleForm user={user} onSetRole={onSetRole} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleForm({ user, onSetRole }: { user: AdminUser; onSetRole: AdminViewProps['onSetRole'] }) {
  const [role, setRole] = useState<Role>(user.role);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const selectId = useId();
  const resultId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || role === user.role) return;
    setSaving(true);
    setResult(null);
    try {
      const message = await onSetRole(user.userId, role);
      setResult({ ok: true, message });
    } catch (caught) {
      // Menyn ställs tillbaka: raden ska läsas som den ÄR, inte som någon hoppades att den blev.
      setRole(user.role);
      setResult({ ok: false, message: roleErrorMessage(caught) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="admin-role-form" onSubmit={(event) => void submit(event)}>
      {/* Etiketten är dold för ögat men läses upp. Den säger "den här raden", aldrig adressen:
          radrubriken ger skärmläsaren personen, och adressen behöver inte upprepas i ett attribut. */}
      <label className="visually-hidden" htmlFor={selectId}>
        {ADMIN_ROLE_SELECT_LABEL}
      </label>
      <select
        id={selectId}
        className="input admin-select"
        value={role}
        disabled={saving}
        aria-describedby={resultId}
        onChange={(event) => setRole(event.target.value as Role)}
      >
        {ROLES.map((value) => (
          <option key={value} value={value}>
            {roleLabel(value)}
          </option>
        ))}
      </select>
      <button type="submit" className="button button-role" disabled={saving || role === user.role}>
        {saving ? ADMIN_ROLE_SAVING : ADMIN_ROLE_BUTTON}
      </button>
      <p
        id={resultId}
        className={result?.ok === false ? 'status-line status-error' : 'status-line'}
        aria-live="polite"
      >
        {result?.message ?? ''}
      </p>
    </form>
  );
}
