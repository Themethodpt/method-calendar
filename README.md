# The Method Calendar

Trainer scheduling for The Method: an admin master calendar, private trainer logins, and a public gym TV board.

- Hosted as a static site (GitHub Pages). No build step.
- Data and logins live in Supabase. Row-level security means trainers can only read their own clients and sessions; the TV page gets first names only through `tv_board()`.
- **No client data belongs in this repository.** Client imports are run once in the Supabase SQL editor from a private file.

## Setup (one time)

1. In Supabase, open **SQL Editor → New query**, paste `supabase/schema.sql`, click **Run**.
2. Run the private client import file the same way (it is not in this repo).
3. In Supabase **Authentication → URL Configuration**, set **Site URL** to the GitHub Pages address.
4. Put the Project URL and anon public key in `config.js`.
5. GitHub repo **Settings → Pages**: deploy from the `main` branch, root folder.
6. Open the site and **create an account first as Craig**: the first account becomes an admin automatically.
7. Each trainer creates an account on the sign-in page; approve and link them under **Trainers & logins**.

## Pages

- `/` the app (sign in)
- `/#tv` the gym TV board (no sign-in; refreshes every minute)
