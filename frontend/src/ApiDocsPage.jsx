import { useMemo } from 'react';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import './styles/ApiDocs.css';

// The /api/v2 reference, rendered from the SAME openapi/gametracker-v2.yaml that CI
// validates and that the drift gate holds the router to. Nothing is duplicated here:
// if an operation is added, removed or renamed, this page changes because the spec did.
//
// WHY NOT A STATIC COPY IN THE BUNDLE. A copy would go stale silently — the whole
// value of this page is that it cannot describe an API the server does not serve.
// The spec is fetched from GET /api/openapi/v2 at render time.

const SPEC_URL = '/api/openapi/v2';

export default function ApiDocsPage() {
  // The spec endpoint is session-authenticated, and SwaggerUI fetches `url` itself
  // rather than handing us the request — so the header goes on through the
  // interceptor, which fires for the spec download as well as for Try-it-out calls.
  //
  // SCOPED TO THE SPEC URL, and that is the load-bearing part. This same interceptor
  // sees every Try-it-out request the user fires at /api/v2/*, and attaching the
  // session JWT to those would be wrong twice over: v2 refuses JWTs by design, and it
  // would silently overwrite the personal access token the user just entered through
  // Authorize — leaving them debugging a 401 that this file caused.
  const requestInterceptor = useMemo(() => (req) => {
    const isSpecRequest = typeof req.url === 'string' && req.url.endsWith(SPEC_URL);
    if (!isSpecRequest) return req;
    const token = localStorage.getItem('token');
    if (token) req.headers = { ...req.headers, Authorization: `Bearer ${token}` };
    return req;
  }, []);

  return (
    <div className="api-docs-page">
      <div className="api-docs-note">
        <h3>Reading this API</h3>
        <p>
          These are the <strong>/api/v2</strong> operations. The page is generated from the
          server&apos;s own contract file, so it always matches what this instance actually serves.
        </p>
        <p>
          <strong>Your login does not work here.</strong> /api/v2 accepts{' '}
          <strong>personal access tokens</strong> only — a session carries no scope, so accepting
          one would make the admin boundary reachable by anyone who can log in with a password.
          To call an endpoint from this page, mint a token and paste it into{' '}
          <strong>Authorize</strong>.
        </p>
        <p className="api-docs-hint">
          Create one under <strong>My Account → API Tokens</strong>. Choose the{' '}
          <code>library</code> scope for your own games, or <code>admin</code> for the
          user-management, settings and jobs operations.
        </p>
        <p className="api-docs-hint">
          If your account signs in through a directory, the browser cannot verify your
          password — mint the token on the server instead:
          <code className="api-docs-cmd">docker compose exec backend node create-api-token.js &lt;user&gt; &quot;name&quot; library</code>
        </p>
        <p className="api-docs-hint">
          The older <strong>/api</strong> surface — the one this web app itself uses — is frozen
          and deliberately has no specification. Generating a client from it would produce one
          carrying three naming conventions and a degradation flag hidden in a header.
        </p>
      </div>

      <SwaggerUI
        url={SPEC_URL}
        requestInterceptor={requestInterceptor}
        // Collapsed by default: 28 operations expanded is a wall of text nobody reads.
        docExpansion="list"
        defaultModelsExpandDepth={-1}
        // Deep linking puts the selected operation in the URL, so a link to one
        // endpoint is shareable — the single most useful thing about a docs page.
        deepLinking
        // NOT persisted. Swagger UI's persistAuthorization writes whatever is entered
        // into localStorage, and what gets entered here is a long-lived personal access
        // token — the one credential in this system that does not expire on its own and
        // cannot be read back after minting. Re-pasting it per session is the correct
        // trade; storing it would put a permanent admin credential next to the 12-hour
        // one, reachable by any XSS this app ever has.
        persistAuthorization={false}
      />
    </div>
  );
}
