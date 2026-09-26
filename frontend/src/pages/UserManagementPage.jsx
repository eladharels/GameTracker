// User Management (admin): the user table, add/edit/delete, password reset, LDAP sync.
// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).
import { useState, useEffect, useRef } from 'react'
import { FaExclamationCircle, FaLock, FaSpinner, FaSync, FaTrash } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { useToast } from '../contexts/ToastContext'
import { useDialogFocus } from '../useDialogFocus'

// The message to show for a failed user-management request (FE-18). The server's own 4xx
// text where there is one — "User already exists", the username and password rules — is
// an `expose: true` message by construction (services/problem.js); a 403 gets a fixed
// sentence; anything else stays generic. Hiding every reason behind "Failed to …" meant
// an admin could not tell a taken username from an outage.
function userApiError(err, fallback) {
  const status = err?.response?.status
  const reason = err?.response?.data?.error
  if (status === 403) return 'You do not have permission to manage users.'
  if (status >= 400 && status < 500 && typeof reason === 'string' && reason) return reason
  return fallback
}

export default function UserManagementPage({ user }) {
  const [users, setUsers] = useState([])
  const [, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The list itself failed to load. The table is then hidden, not shown empty: an empty
  // user table reads as "there are no users", which a failed request is not.
  const [loadFailed, setLoadFailed] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', can_manage_users: false })
  // Success goes to the global toast, the app's usual feedback, and dismisses itself
  // (FE-18). It was a solid, centred green block that stayed until the next action, beside
  // a translucent error banner of a different design.
  const { showToast } = useToast()
  const [ldapSyncLoading, setLdapSyncLoading] = useState(false)
  const [formError, setFormError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwTarget, setPwTarget] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [pwError, setPwError] = useState('')
  // While a delete is in flight the confirm dialog stays open (it closes after the refetch,
  // for focus). Its Delete button is disabled meanwhile: a double-click sent a second
  // DELETE, which 404'd into "Failed to delete user" right after the success toast.
  const [deleting, setDeleting] = useState(false)
  const modalRef = useRef()
  const confirmModalRef = useRef()
  const pwModalRef = useRef()
  const addUserFirstInputRef = useRef()
  const pwInputRef = useRef()

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await api.get(`${API_BASE}/users`)
      setUsers(res.data)
      setLoadFailed(false)
      setLoading(false)
    } catch (err) {
      // 401 is the api.js interceptor's to handle (it ends the session). A 403 is NOT
      // "logged out" (ROADMAP P0-6): this handler used to delete the token and navigate
      // to /login while React still held the user, so the app bounced to /search looking
      // signed in and every later request failed.
      // A 401 normally never shows: the interceptor ends the session and reloads. It
      // only acts when a token is stored, though — after a logout in ANOTHER tab this
      // one sends no token, and a silent empty page is the wrong answer to that.
      const status = err.response?.status
      setError(status === 403 ? 'You do not have permission to manage users.'
        : status === 401 ? 'Your session has ended. Please sign in again.'
        : 'Failed to load users')
      setLoadFailed(true)
      setLoading(false)
    }
  }
  useEffect(() => { fetchUsers() }, [])

  const handleCreate = async (e) => {
    e.preventDefault()
    setError('')
    setFormError('')
    // Basic validation
    if (!newUser.username.trim() || !newUser.password.trim()) {
      setFormError('Username and password are required.')
      return
    }
    try {
      await api.post(`${API_BASE}/users`, newUser)
      showToast('success', 'User created!')
      setNewUser({ username: '', password: '', can_manage_users: false })
      fetchUsers()
    } catch (err) {
      // The server's reason, next to the form it concerns (FE-18): "Username already
      // exists" and the username rules are exposed 4xx messages (services/problem.js), and
      // "Failed to create user" hid every one of them. Anything else stays generic.
      setFormError(userApiError(err, 'Failed to create user.'))
    }
  }
  const handleDelete = async (id) => {
    setError('')
    try {
      await api.delete(`${API_BASE}/users/${id}`)
      showToast('success', 'User deleted!')
      // AWAITED so the confirm dialog closes after the row is gone: closing first returned
      // focus to that row's Delete button, which the refetch then removed, leaving focus
      // on <body> (FE-19 review). Now the hook's fallback — the page heading — takes it.
      await fetchUsers()
    } catch (err) {
      setError('Failed to delete user')
    }
  }

  const confirmDelete = (id) => {
    setConfirmTarget(id)
    setConfirmOpen(true)
  }

  const handlePasswordChange = (id) => {
    setPwTarget(id)
    setNewPassword('')
    setPwError('')   // a previous attempt's error must not greet the next one
    setPwModalOpen(true)
  }

  // The dialog stays OPEN on failure and says why, next to the field (FE-18 review): it
  // used to close regardless and put a generic "Failed to update user" on the page, so a
  // password the policy rejected looked like a success that had not happened.
  const pwSubmitting = useRef(false)   // a double Enter sent two PUTs (and two toasts)
  const submitPasswordChange = async () => {
    if (!newPassword.trim() || pwSubmitting.current) return
    pwSubmitting.current = true
    setPwError('')
    let ok
    try { ok = await handleEdit(pwTarget, { password: newPassword }, { onError: setPwError }) }
    finally { pwSubmitting.current = false }
    if (!ok) return
    setPwModalOpen(false)
    setNewPassword('')
    setPwTarget(null)
  }
  // Returns whether it succeeded. `onError` routes the message to a dialog instead of the page.
  const handleEdit = async (id, updates, { onError } = {}) => {
    setError('')
    try {
      await api.put(`${API_BASE}/users/${id}`, updates)
      showToast('success', 'User updated!')
      fetchUsers()
      return true
    } catch (err) {
      const message = userApiError(err, 'Failed to update user.')
      if (onError) onError(message)
      else setError(message)
      return false
    }
  }

  const handleLdapSync = async () => {
    setLdapSyncLoading(true)
    setError('')
    
    try {
      const response = await api.post(`${API_BASE}/admin/ldap-sync`, {})
      
      const result = response.data
      if (result.success) {
        // Longer than the default: a sentence with two numbers in it must be READ before
        // it dismisses itself (FE-18 review).
        showToast('success', `LDAP sync completed! ${result.results.updated} users updated out of ${result.results.total} LDAP users.`, { duration: 10000 })
        fetchUsers() // Refresh the user list to show updated information
      } else {
        setError('LDAP sync failed')
      }
    } catch (err) {
      setError(err.response?.data?.error || 'LDAP sync failed')
    } finally {
      setLdapSyncLoading(false)
    }
  }

  // Modal close on ESC
  useEffect(() => {
    if (!modalOpen && !confirmOpen && !pwModalOpen) return;
    function onKey(e) {
      if (e.key === 'Escape') {
        if (pwModalOpen) { setPwModalOpen(false); return }
        if (confirmOpen) { if (!deleting) setConfirmOpen(false); return }   // not mid-delete
        setModalOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, confirmOpen, pwModalOpen, deleting])

  // Focus in on open, back to the opener on close, Tab kept inside (FE-19). These focused
  // an input after a 50 ms setTimeout and never gave focus back; the delete confirmation
  // got no initial focus at all. An alertdialog opens on its LEAST destructive action, so
  // an Enter pressed out of habit cancels rather than deletes. Escape stays with the
  // window listener above, which knows which dialog is on top.
  const confirmCancelRef = useRef(null)
  const confirmDialog = useDialogFocus(confirmOpen, { initialRef: confirmCancelRef })
  const pwDialog = useDialogFocus(pwModalOpen, { initialRef: pwInputRef })
  const addUserDialog = useDialogFocus(modalOpen, { initialRef: addUserFirstInputRef })

  function handleModalBgClick(e) {
    if (e.target === modalRef.current) setModalOpen(false)
  }

  // Modern card-based UI
  return (
    <div className="user-management-page-modern">
      <div className="user-management-toolbar">
        <div>
          <div className="user-mgmt-subtitle">Manage your team members and their account permissions here.</div>
        </div>
        <div className="user-management-actions">
          <button 
            className="ldap-sync-btn" 
            onClick={handleLdapSync}
            disabled={ldapSyncLoading}
          >
            {ldapSyncLoading ? (
              <>
                <FaSpinner className="spin-icon" style={{marginRight:6}} />
                Syncing...
              </>
            ) : (
              <>
                <FaSync style={{marginRight:6}} />
                Sync LDAP Users
              </>
            )}
          </button>
          <button className="add-user-btn" onClick={() => setModalOpen(true)}>Add User</button>
        </div>
      </div>
      {confirmOpen && (
        <div className="user-modal-bg" ref={confirmModalRef} onClick={e => { if (e.target === confirmModalRef.current && !deleting) setConfirmOpen(false) }} tabIndex={-1} aria-modal="true" role="alertdialog" aria-labelledby="confirm-dialog-title" onKeyDown={confirmDialog.onKeyDown}>
          <div className="user-modal-window" style={{maxWidth: 400}}>
            <h3 id="confirm-dialog-title" style={{marginTop:0}}>Delete User</h3>
            <p style={{color:'var(--color-fg-muted)'}}>Are you sure you want to delete this user? This cannot be undone.</p>
            <div style={{display:'flex', gap:'1rem', justifyContent:'flex-end', marginTop:'1.5rem'}}>
              <button ref={confirmCancelRef} className="icon-btn enhanced-icon-btn" style={{padding:'0.6em 1.4em'}} aria-disabled={deleting || undefined} onClick={() => { if (!deleting) setConfirmOpen(false) }}>Cancel</button>
              <button
                className="create-user-btn enhanced-btn"
                style={{background:'#ef4444', padding:'0.6em 1.4em'}}
                // aria-disabled, NOT disabled (FE-18 review): disabling the FOCUSED button
                // dropped focus to <body> mid-request — the trap stopped working and
                // "Deleting…" was never announced. The guard below blocks a second click.
                aria-disabled={deleting || undefined}
                onClick={async () => {
                  if (deleting) return
                  setDeleting(true)
                  try { await handleDelete(confirmTarget) } finally { setDeleting(false); setConfirmOpen(false) }
                }}
              >{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
      {pwModalOpen && (
        <div className="user-modal-bg" ref={pwModalRef} onClick={e => { if (e.target === pwModalRef.current) setPwModalOpen(false) }} tabIndex={-1} aria-modal="true" role="dialog" aria-labelledby="pw-dialog-title" onKeyDown={pwDialog.onKeyDown}>
          <div className="user-modal-window" style={{maxWidth: 400}}>
            <button className="user-modal-close" aria-label="Close" onClick={() => setPwModalOpen(false)}>&times;</button>
            <h3 id="pw-dialog-title" style={{marginTop:0}}>Change Password</h3>
            <div className="user-form-group" style={{flexDirection:'column'}}>
              <label htmlFor="pw-new-input" style={{fontWeight:600, marginBottom:'0.35rem'}}>New Password</label>
              <input
                id="pw-new-input"
                ref={pwInputRef}
                type="password"
                className="ent-input"
                placeholder="Enter new password"
                value={newPassword}
                onChange={e => { setNewPassword(e.target.value); if (pwError) setPwError('') }}
                onKeyDown={e => { if (e.key === 'Enter') submitPasswordChange() }}
                aria-invalid={pwError ? true : undefined}
                aria-describedby={pwError ? 'pw-error' : undefined}
              />
            </div>
            {pwError && <div id="pw-error" className="gt-alert gt-alert--danger" role="alert"><FaExclamationCircle aria-hidden="true" /><div>{pwError}</div></div>}
            <div style={{display:'flex', gap:'1rem', justifyContent:'flex-end', marginTop:'1.5rem'}}>
              <button className="icon-btn enhanced-icon-btn" style={{padding:'0.6em 1.4em'}} onClick={() => setPwModalOpen(false)}>Cancel</button>
              <button
                className="create-user-btn enhanced-btn"
                disabled={!newPassword.trim()}
                onClick={submitPasswordChange}
              >Change Password</button>
            </div>
          </div>
        </div>
      )}
      {modalOpen && (
        <div className="user-modal-bg" ref={modalRef} onClick={handleModalBgClick} tabIndex={-1} aria-modal="true" role="dialog" aria-labelledby="add-user-dialog-title" onKeyDown={addUserDialog.onKeyDown}>
          <div className="user-modal-window">
            <button className="user-modal-close" aria-label="Close" onClick={() => setModalOpen(false)}>&times;</button>
            <h3 id="add-user-dialog-title" style={{marginTop:0, marginBottom:'1rem'}}>Add User</h3>
            <form className="user-form-modern user-form-vertical user-form-enhanced" onSubmit={handleCreate}>
              <div className="user-form-group">
                <label>Username
                  <input
                    ref={addUserFirstInputRef}
                    type="text"
                    placeholder="Username"
                    value={newUser.username}
                    onChange={e => setNewUser({ ...newUser, username: e.target.value })}
                    required
                  />
                </label>
                <label>Password
                  <input
                    type="password"
                    placeholder="Password"
                    value={newUser.password}
                    onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                    required
                  />
                </label>
              </div>
              <div className="user-form-group user-form-checkboxes enhanced-toggles" style={{justifyContent: 'flex-start', alignItems: 'center', gap: '2.2rem', marginBottom: '0.5rem'}}>
                <label className="switch-modern enhanced-switch">
                  <input type="checkbox" checked={newUser.can_manage_users} onChange={e => setNewUser({ ...newUser, can_manage_users: e.target.checked })} />
                  <span className="slider-modern enhanced-slider"></span>
                  <span className="switch-label enhanced-switch-label">Admin</span>
                </label>
              </div>
              {formError && <div className="gt-alert gt-alert--danger" role="alert"><FaExclamationCircle aria-hidden="true" /><div>{formError}</div></div>}
              <button type="submit" className="create-user-btn enhanced-btn">Create User</button>
            </form>
            {error && <div className="gt-alert gt-alert--danger" role="alert"><FaExclamationCircle aria-hidden="true" /><div>{error}</div></div>}
          </div>
        </div>
      )}
      {/* Page-level messages. They used to render ONLY inside the Add User dialog, so a
          failed load, delete or LDAP sync with the dialog closed said nothing at all. While
          the dialog is open it shows them itself, next to the form they concern. */}
      {!modalOpen && error && (
        <div className="gt-alert gt-alert--danger gt-alert--page" role="alert">
          <FaExclamationCircle aria-hidden="true" />
          <div>
            {error}
            {/* With the table hidden, retrying is otherwise only a page reload. */}
            {loadFailed && (
              <><br /><button type="button" className="gt-alert-action" onClick={() => { setError(''); fetchUsers() }}>
                <FaSync aria-hidden="true" /> Retry
              </button></>
            )}
          </div>
        </div>
      )}
      {!loadFailed && (
      <div className="user-table-section">
        <table className="user-table-modern">
          <thead>
            <tr>
              <th>Avatar</th>
              <th>Name</th>
              <th>Full name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Date Joined</th>
              <th>Permissions</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              function stringToColor(str) {
                let hash = 0;
                for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
                const h = Math.abs(hash) % 360;
                return `hsl(${h}, 70%, 80%)`;
              }
              const avatarBg = stringToColor(u.username || 'U');
              const avatarLetter = (u.username && u.username.length > 0) ? u.username[0].toUpperCase() : '?';
              let role = 'User';
              if (u.can_manage_users) role = 'Admin';
              // Use real created_at date if available
              let joined = u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Unknown';
              return (
                <tr key={u.id}>
                  <td><div className="user-table-avatar" style={{ background: avatarBg }} aria-label={`Avatar for ${u.username}` }>{avatarLetter}</div></td>
                  <td><span className="user-table-name">{u.username}</span></td>
                  <td><span className="user-table-fullname">{u.display_name || ''}</span></td>
                  <td><span className="user-table-email" title={u.email || 'No email set'}>{u.email || '—'}</span></td>
                  <td><span className="user-table-role">{role}</span></td>
                  <td><span className="user-table-date">{joined}</span></td>
                  <td>
                    <div className="user-table-perms">
                      <label className="switch-modern enhanced-switch" title="Toggle Admin Permission">
                        <input
                          type="checkbox"
                          aria-label={`Admin permission for ${u.username}`}
                          checked={!!u.can_manage_users}
                          disabled={u.username === 'root' || u.id === user.id}
                          onChange={e => handleEdit(u.id, { can_manage_users: e.target.checked })}
                        />
                        <span className="slider-modern enhanced-slider"></span>
                      </label>
                    </div>
                  </td>
                  <td><span className="user-table-source">{u.origin === 'ldap' ? 'LDAP' : 'Local'}</span></td>
                  <td>
                    <div className="user-table-actions">
                      <button className="icon-btn enhanced-icon-btn" title="Change Password" aria-label={`Change password for ${u.username}`} onClick={() => handlePasswordChange(u.id)}><FaLock /></button>
                      <button className="icon-btn enhanced-icon-btn" title="Delete User" aria-label={`Delete user ${u.username}`} onClick={() => confirmDelete(u.id)} disabled={u.username === 'root'}><FaTrash /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}
