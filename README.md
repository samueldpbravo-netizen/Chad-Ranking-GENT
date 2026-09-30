# Chad Ranking

Static site for GitHub Pages. **You are the only one who can change names, pictures and descriptions**, because they live in `roster.js` and `images/` inside your repo. The page itself has no editing controls, and only people with push access to the repo can change those files.

## Deploy
1. Create a GitHub repo and upload everything in this folder.
2. Repo **Settings > Pages > Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Your site goes live at `https://<you>.github.io/<repo>/`. Do not add collaborators if you want to stay the only editor.

## Edit names, descriptions, pictures
- Open `roster.js` on GitHub, click the pencil, change `name`, `subtitle`, `description`, `image`, commit.
- Upload pictures into `images/` (Add file > Upload files) and set `image: 'images/thor.jpg'`. Square photos work best.
- Never change an `id` after voting starts. Deleting a person drops them from every ballot and average.

## Turn on shared voting (required for one combined ranking)
Without this step each visitor's ballot stays in their own browser and nobody sees anyone else's votes. With it, every ballot is stored in one database and every visitor's page computes the same General Ranking, PSL and Appeal averages from all of them, live.
1. Go to console.firebase.google.com, create a project, add a Web app, copy the config object.
2. Build > Authentication > Sign-in method: enable **Anonymous**.
3. Build > Firestore Database: create it, then paste `firestore.rules` into the Rules tab and publish.
4. Put your config in `config.js` (replace the `null` line, see the comment there) and commit.
5. In Authentication > Settings > Authorized domains, add `<you>.github.io`.

The Firebase web config is not a secret; the rules are what protect the data. Each visitor gets an anonymous id, so clearing browser data means a fresh ballot, and someone determined could vote several times that way. Fine for a friend group.
