// My Word Book — accounts (Firebase Authentication + Firestore)
// Used by the homepage (sign up / log in) and by the app (checks you are signed in and your trial).
(function(){
  const MWB = window.MWB = window.MWB || {};
  const DAY = 24 * 60 * 60 * 1000;
  let app = null, auth = null, db = null;

  MWB.configured = () => !!(window.MWB_FIREBASE && window.MWB_FIREBASE.apiKey && !/PASTE/.test(window.MWB_FIREBASE.apiKey));
  MWB.trialDays = () => Math.max(1, Math.min(14, +window.MWB_TRIAL_DAYS || 14));

  MWB.init = function(){
    if(app) return true;
    if(!window.firebase || !MWB.configured()) return false;
    app = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.MWB_FIREBASE);
    auth = firebase.auth(); db = firebase.firestore();
    try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch(e){}
    try { auth.useDeviceLanguage(); } catch(e){}
    return true;
  };

  // age from a birth year (people born late in the year are counted younger, to be safe)
  MWB.ageFromYear = y => { y = +y; if(!(y > 1900)) return null; return new Date().getFullYear() - y - 1; };

  // plain-language error messages
  MWB.errorText = function(e){
    const c = (e && e.code) || "";
    return ({
      "auth/email-already-in-use": "There's already an account with this email. Try logging in, or use “Forgot password”.",
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/weak-password": "Please choose a longer password (at least 8 characters).",
      "auth/missing-password": "Please type a password.",
      "auth/wrong-password": "That password isn't right. Try again or use “Forgot password”.",
      "auth/invalid-credential": "The email or password isn't right. Try again or use “Forgot password”.",
      "auth/invalid-login-credentials": "The email or password isn't right. Try again or use “Forgot password”.",
      "auth/user-not-found": "No account uses this email yet. Tap “Sign up” to create one.",
      "auth/too-many-requests": "Too many tries. Please wait a few minutes and try again.",
      "auth/network-request-failed": "No internet connection. Check your Wi-Fi and try again.",
      "auth/popup-closed-by-user": "The Google window was closed before signing in.",
      "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups, or sign up with email.",
      "auth/unauthorized-domain": "This website isn't allowed in Firebase yet. Add it under Authentication → Settings → Authorized domains.",
      "auth/operation-not-allowed": "This sign-in method isn't turned on in Firebase yet (Authentication → Sign-in method).",
      "permission-denied": "Your account couldn't be saved (Firestore rules). Make sure the rules from firestore.rules are published."
    })[c] || (e && e.message ? e.message.replace(/^Firebase:\s*/, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "") : "Something went wrong. Please try again.");
  };

  // ---------- profile ----------
  MWB.profileRef = uid => db.collection("users").doc(uid);
  MWB.getProfile = async uid => { const s = await MWB.profileRef(uid).get(); return s.exists ? s.data() : null; };
  async function createProfile(user, info){
    const now = Date.now(), age = MWB.ageFromYear(info.birthYear), under13 = age != null && age < 13;
    const p = {
      name: String(info.name || user.displayName || "").trim().slice(0, 60),
      birthYear: +info.birthYear || null,
      under13,
      parentConsent: under13 ? !!info.parentConsent : null,
      accountEmail: user.email || "",
      role: under13 ? "child (parent's email)" : (age != null && age < 18 ? "student" : "adult"),
      plan: "trial",
      trialEnds: firebase.firestore.Timestamp.fromMillis(now + MWB.trialDays() * DAY),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await MWB.profileRef(user.uid).set(p);
    return p;
  }
  MWB.completeProfile = async info => { const u = auth.currentUser; if(!u) throw {code: "no-user"}; return createProfile(u, info); };

  // ---------- sign up / log in ----------
  MWB.signUp = async function(info){
    const age = MWB.ageFromYear(info.birthYear);
    if(age == null) throw {message: "Please choose the year you were born."};
    if(age < 13 && !info.parentConsent) throw {message: "A parent or guardian needs to tick the permission box."};
    const cred = await auth.createUserWithEmailAndPassword(String(info.email).trim(), info.password);
    try { await cred.user.updateProfile({displayName: String(info.name || "").trim().slice(0, 60)}); } catch(e){}
    await createProfile(cred.user, info);
    await cred.user.sendEmailVerification({url: location.origin + "/app.html"}).catch(() => {});
    return cred.user;
  };
  MWB.logIn = async (email, password) => (await auth.signInWithEmailAndPassword(String(email).trim(), password)).user;
  MWB.google = async function(){
    const prov = new firebase.auth.GoogleAuthProvider(); prov.setCustomParameters({prompt: "select_account"});
    try { return (await auth.signInWithPopup(prov)).user; }
    catch(e){ if(e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")){ await auth.signInWithRedirect(prov); return null; } throw e; }
  };
  MWB.resetPassword = email => auth.sendPasswordResetEmail(String(email).trim(), {url: location.origin + "/?login=1"});
  MWB.resendVerify = () => auth.currentUser && auth.currentUser.sendEmailVerification({url: location.origin + "/app.html"});
  MWB.signOut = () => auth.signOut();
  MWB.user = () => auth && auth.currentUser;
  MWB.onUser = fn => auth.onAuthStateChanged(fn);
  MWB.reload = async () => { if(auth.currentUser) await auth.currentUser.reload(); return auth.currentUser; };
  // Google accounts are already verified by Google; email accounts must click the link in their email
  MWB.needsVerify = u => !!u && !u.emailVerified && (u.providerData || []).some(p => p.providerId === "password");

  // ---------- trial / plan ----------
  MWB.access = function(profile){
    if(!profile) return {ok: false, reason: "no-profile"};
    const ms = v => v && v.toMillis ? v.toMillis() : +v || 0;
    if(profile.plan === "active" || profile.plan === "paid" || (profile.paidUntil && ms(profile.paidUntil) > Date.now())) return {ok: true, plan: "paid"};
    const left = ms(profile.trialEnds) - Date.now();
    if(left > 0) return {ok: true, plan: "trial", daysLeft: Math.ceil(left / DAY)};
    return {ok: false, reason: "trial-over", plan: "trial"};
  };
})();
