// Props for the app's router — ONE definition, used by main.jsx and by the routed tests, so
// a test renders the router the app actually ships (review of FE-22).
//
// useTransitions: false. React Router 7 wraps every router state update in
// React.startTransition by default; v6 did not. That broke FE-14's "back to where you
// were": LoginPage's setUser(session) is an ORDINARY update, so the signed-in app rendered
// first while the location was still /login, matched the signed-in catch-all's
// <Navigate to="/search"/>, and that push overtook navigate(returnPath), which was still
// waiting in its transition. Nothing here uses transitions deliberately.
export const ROUTER_PROPS = Object.freeze({ useTransitions: false })
