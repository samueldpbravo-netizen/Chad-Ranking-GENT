# Chad Ranking

Static site for GitHub Pages with shared voting through Firebase. Everybody needs an account (name + email + password) and must verify the email, so one person gets one ballot.

## One-time Firebase setup
1. Authentication > Sign-in method: keep **Google** enabled (instant login) and also enable **Email/Password** (needed for the admin account and email sign-up).
2. Authentication > Settings > Authorized domains: add `<you>.github.io`.
3. Firestore Database: create it, then Rules tab > paste `firestore.rules` > **Publish**.
4. Authentication > Users > **Add user**: email `admin@chadranking.app` and your admin password. Do this before sharing the site.
5. Open `check.html` on your site; every line must be green.

## Admin page
Open `https://<you>.github.io/<repo>/#admin` (tiny "Admin" link bottom-left) and enter the admin password.
- **People**: the list loads from `roster.js` automatically the first time, then add, edit, reorder and remove people (names, subtitles, Snapchat, images, descriptions).
- **Members**: see name and email of everyone, delete ballots, ban an email.
- **Banned**: ban or unban emails. Banned emails cannot log in to vote or see the ranking.
Old anonymous ballots from before the login existed show up as "Unknown ballot": delete them.

## Pictures
Upload into `images/` and put the path (e.g. `images/thor.jpg`) in the admin page. `roster.js` only provides the starting list.
