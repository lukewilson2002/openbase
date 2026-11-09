# Changelog

All notable changes to OpenBase are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, a new minor
version (0.2.0) may contain breaking changes; read its notes before upgrading.

Releases are published from [GitHub Releases](https://github.com/lukewilson2002/openbase/releases)
(see [docs/releasing.md](docs/releasing.md)). Write changes under **Unreleased** as you go;
`scripts/release.sh X.Y.Z` turns that section into the release's.

## [Unreleased]

### Added

- **A new look and new words.** The whole app is redrawn in one quiet style (the Notebook look: paper-like
  surfaces, one accent color, light and dark, 2 px focus rings) and the interface now says **Workspace**,
  **Folder** (it was project or base), **Collection** (table), **Record**, **Property** (field), **View**,
  **Layout** and **Page**; a Kanban layout is a **Board**. Workspaces, folders and collections are told apart
  by color; icons are no longer shown or picked (they stay in the API). The API, the MCP tools and stored data
  keep their names, and the Airtable-compatible API answers as before. A workspace's top-level folder holds
  the collections that sit directly under it. On a phone, menus, pickers and editors are bottom sheets, every
  target is 44 px, and the bottom navigation has Home, Collections and Notifications. Every screen was
  checked with axe-core in both themes at desktop and phone width, and with the keyboard. A shared-view link
  draws the app's own grid, board, list, calendar and timeline, read-only, and a shared grid loads its rows as
  it is scrolled instead of in pages of 100.
- **Home.** `/workspace/<id>` is the workspace's Home. A capture box puts a thought down as a draft or as a
  record in the collection you pick; a date written in words ("friday 3pm") becomes the record's date, and a
  dashed chip sets any other property. Below it are what is due soon (from every collection with a Home date,
  with a Done checkbox), the records changed recently and your drafts, which used to be the Inbox page (old
  `/inbox` links come here). Home's data is one request and it updates live through a new stream for the whole
  workspace, `GET /api/workspaces/{id}/events` (one connection instead of one per folder; no presence).
- **Faster first screen.** Home, a record page, notifications and the two workspace lists load when you go to
  them, so opening a collection loads 16% less JavaScript than `main` did before this release (759 KiB against
  907 KiB; `main` is 42 commits past 0.8.0), and a collection of 50,000 records shows its first rows in 733 ms
  against 767 ms (median of 5 runs on one laptop; `scripts/perf-compare.sh` measures it, and `MAIN_REF=v0.8.0`
  measures against the release itself).
- **Sign-in pages, the intro and error screens in the Notebook look.** Login, first-run setup, sign-up, invite and
  password reset share one 400 px card under the OpenBase lockup, with 44 px inputs, a full-width primary button and the
  passkey as a secondary button; invite pages show the workspace by its color mark. The first workspace is made from a
  name and a color. The five-step intro now explains Home and capture, collections and record pages, views and drafts,
  workspaces and folders, and the optional assistant, with pictures drawn from the app's own components. Delete
  confirmations name the thing and say whether it can be restored ("moves to the trash for 30 days", with the server's
  `OPENBASE_TRASH_DAYS`, now also reported as `trash_days` by `GET /api/setup`). Not-found and error screens say what
  happened and what to do, and lead to Home.
- **History, Trash, settings, Members, Account and Admin in the Notebook look.** History and Trash filter with chips in a
  bar like a collection's (workspace, folder, collection, person, kind); the Trash has kind chips, each item's color mark,
  who deleted it, the days left and Restore, and `GET /api/history` places and `GET /api/trash` items carry `table_color`.
  Workspace settings lets owners choose the top-level folder, and Members shows Folder access with the top level first.
  Account has a week start on the profile (used by "this week" filters), and API tokens, connected apps and the consent
  screen share Read, Read and write and Full control with one plain sentence each. A connected app's access can be
  changed from Account, AI assistants with Change access, and applies from its next request. Admin's tables share one style.
- **A record is a page.** Opening a record, from any layout, a search result, a notification or a
  linked record, goes to its own address (`/base/<folder>/<collection>/<view>/r/<record>`) instead of
  a window over the collection. A bar on top holds the breadcrumb (folder, collection, record),
  Previous and Next record (Alt+Up and Alt+Down; they follow the view the page was opened from,
  with your unsaved changes to it, and a Board, Calendar, Timeline or List steps the way it shows
  its records), who is viewing, Comments and History in a panel on the right, Share (the phone's
  share sheet where there is one, else it copies the link) and More (Duplicate, Copy link, Delete).
  Saving, Saved and Couldn't save are at its left. On a phone the 56 px header has the way back, named
  for the collection, Comments, Share and More, and the bottom navigation steps aside. Escape returns
  to the collection the page was opened from, whatever number of linked records were opened since;
  the browser's back goes one page at a time. Old `?record=` and `?linked=` links (emails,
  notifications, history) land on the page, and a link followed while signed out comes back to it
  after sign-in. A linked record's chip opens its page. The expanded-record window and the stack of
  linked-record panels are gone. Back from a page (the browser's back, Escape or the phone's back link)
  lands where the list was scrolled to, Ctrl+Z still reverts what was done in the collection before the
  page was opened, and Previous and Next ask the server for just the two records either side of this one,
  so they work in a collection of any size (`neighbours_of` on `POST /api/views/{id}/query`).
- **A record reads like a document.** The page starts with a tile in the collection's colour holding
  the title's initials (the record's own picture when the first file of one of the collection's file
  properties is an image), then the title, edited where it stands (Enter commits it and moves on).
  Below it is a list of the properties that have a value, in the order of the collection's default
  grid. Properties with nothing in them fold into "Show 2 empty properties", and properties the default
  grid hides fold into "Show 1 hidden property"; both folds are remembered on this device. A value is
  text until you click or tap it, then it is its editor, and it saves on its own. A property's name
  opens its menu: creators get Rename, Edit property and Delete, and editors and up get Hide from pages
  and Show on pages, which change the default grid's layout at once. Viewers see everything with
  nothing to edit, and commenters can also comment. Files in a record are small bordered tiles.
- **Add a property from a record.** Creators see "Add property" under a record's properties. It opens
  a box with a Name and a Value; as you type the value, a chip says what type it looks like ("Date ·
  Guessed from “Nov 14”") and Change type offers every type, links and choices included. Enter makes
  the property, puts it last in the default grid and sets this record's value, so a rating written as
  stars, a checkbox written as yes or a check mark and a date written as "Friday" all arrive as what they
  mean. Escape cancels. A link, formula, lookup, rollup, count or button carries on in the property
  dialog with the name filled in.
- **Choose which property is the title or the page.** "Use as title" is in a property's menu in the
  grid header and on the record page (and in the collection's settings); a property whose type cannot be
  the title is dimmed with the reason. "Use as page" is on rich text properties. Deleting or retyping the
  page property leaves the collection without a page and refuses nothing, as before.
- **The page of a record.** Under the properties and a thin rule, a record's page is the rich text
  editor with no box and no toolbar, always ready to type in for editors and up. Markdown works as you
  type (`# `, `- `, `1. `, `> `, three backticks, `**bold**`). `/` opens a menu of blocks: Heading 1 to 3,
  Bulleted list, Numbered list, Checklist, Quote, Callout, Code block, Table, Divider, Image or file,
  Linked records, View and Property (it opens Add property). Selecting text shows a bubble with bold,
  italic, strike, code and link; Ctrl+K (Cmd+K) adds a link while the page has focus and the command
  palette stays closed. On a phone a bar above the keyboard has the same controls, the lists' indent and
  outdent and a + that opens the block menu. The page saves 800 ms after you stop typing, as an
  ordinary save of the Page property, and the bar says Saving, Saved or Couldn't save. Linked records and
  View write the embed's fenced `openbase` block with the property or view you pick (see the next entry).
  Viewers and commenters read the page rendered. In a collection with no Page property creators and
  editors alike can type at once and the first save makes "Page"; creators also have "Add Page property"
  beside the editor. HTML that the page has no markup for (a `<script>` or `<div>`, a stray tag, a comment)
  stays as text when the page is saved. Text still waiting for its pause is saved when the tab is closed.
- **Embeds in a page: linked records and views.** A page can show a small table of this record's linked
  records, or the first records of any saved view of the workspace. Linked records picks one of the record's
  link properties: the linked collection's title and its first three visible properties, a caption such as
  "Invoices · linked to this client, 2", **Open** (the collection with a draft filter on the link back to this
  record, saved nowhere), rows that open the records' pages and, for editors, a **+ Link** row that adds links
  through the link picker. View shows the first ten records of the view (more with `"limit"`, up to 50),
  read-only, with **Open view**; a reader who cannot open the view sees "You can't open this view" and nothing
  of its name or records. Personal views cannot be embedded. An embed is stored as a fenced code block with the
  info string `openbase` and one JSON object, `{"embed":"linked","field":"fld…"}` or
  `{"embed":"view","view":"viw…","limit":10}`, so agents and the API can write one; it is read strictly
  (those keys only, ids in the shape of ids) and drawn by components, never as HTML. Embeds are alive only in the
  page of a record opened by a signed-in person: shared pages, forms, comments, grid cells and previews show a
  static "Embedded view" box and fetch nothing, and notification snippets say "Embedded view". A block that does
  not read shows "This embed can't be shown" and keeps its text. Search skips the JSON.
- **Comments and History are a panel you leave open.** On a desktop each opens a 360 px panel on the
  right of the record page, beside the page rather than over it; switching between them keeps the panel,
  and which one is open (or none) is remembered on this device, so the next record opens with it
  already there, without taking the keyboard from the page. On a phone each is a full-screen sheet
  with the box to write a comment kept above the keyboard, and nothing is remembered, so a record
  never opens covered. The Comments button carries the number of comments on the desktop's bar and the
  phone's header, and follows comments others write. The panels are restyled: names, times and
  properties use the type scale, a thread loads as a skeleton, an empty one says so, and a long value in
  History is cut after a few lines.
- **A new record opens as its page.** The New button in the collection's header, the phone's +, the
  "+ New client" rows in a List and the end of a Board stack, and the New button of an empty Grid add a
  record and open its page with the title ready to type in; only the "+ New client" row at the end of a
  Grid stays inline. Leave a record you just added with nothing in it (Escape in its empty title, the
  back link, the browser's back, any other screen, or closing the tab) and it is taken back as if it
  had never been added: not in the trash, not in History. A record you typed anything into, commented on
  or linked stays.
- **The link picker and the linked-record preview in the new look.** Picking records to link is a
  list of the collection's records with their description and labels, the highlighted row in the
  accent's soft fill; on a phone it is a bottom sheet with the search at the top, which opens with the
  keyboard down so the list can be read first, and Done at the sheet's head. Hovering a linked record
  (on the record page, in a card or a chip, or on the grid) shows a small card with its title, its
  collection's colour and every property it has a value for, and **Open page**, a real link to the
  record's page (a modified click opens it in a new tab); on a phone, holding a finger on a linked
  record shows the same in a sheet with Open page at its foot. The property dialog's link target says
  "Collections in other folders can't be linked" and shows each collection by its colour, never its
  icon (the same in the automation editor's collection pickers); the formula editor's `{Property}`
  suggestions and live check, and the choice editor's pastel chips and "next palette color" for a new
  choice, are as they were, restyled. Inputs and selects are 44 px tall on a phone. The property type
  list opens scrolled to the chosen type, a linked card's label ("Amount") keeps up to half the card
  instead of being cut to three letters on a phone, and the phone's linked-record sheet names the record
  once.
- **The grid, List and Board in the new look.** The grid's header row is 12 px and muted on the
  page's grey, the title column is bold, choices are drawn as chips in their own colour and linked
  records as chips with the colour of their collection, and each group ends in "+ New client" (the
  collection's record name). New views and new collections start on Medium rows (46 px; Short is now
  36 px); views you already have keep the row height they were saved with. A List row and a Board
  card are cards: the title, then up to three properties on one line (a choice as a chip, a date,
  numbers at the right). Board stacks are 280 px wide with the stack's value as a chip and its card
  count, and a "+ New client" at the foot. The column menu says "property": Rename, Edit property,
  Insert left and right, Hide and Delete.
- **The Calendar, Gallery, Timeline and Form in the new look.** Every surface, line and event
  of the calendar and the timeline now follows the theme, light and dark: days are white, the
  header and the days of the neighbouring months are the page's grey, events are flat chips in
  their colour, and nothing is raised with a shadow. The timeline draws today as a dashed line in
  the accent. Gallery cards are bordered cards with 12 px corners that take their cover's top
  corners, and the Unscheduled column beside the calendar and the timeline is the page's grey with
  flat cards. The form builder and its preview are cards on the page with the same type sizes as
  the rest of the app. A calendar, board or timeline that has no property to use yet asks for one
  in words and a button, without the little picture it used to draw.
- **Empty collections and filtered-to-nothing views.** A view with no records says "No clients yet"
  with "New client" (after the collection's record name); a view whose filter or search matches
  nothing says "No clients match these filters" with Reset, which clears the filter and search in
  your draft (the saved view keeps its filter). Board, List, Gallery and the grid all do this.
- **Selection and holds on a phone.** On a phone the bar for selected records shrinks to the count,
  an Actions button and a way to let go; Duplicate, Delete and a Board's "Move to" are rows of a
  bottom sheet. A hold on a card or row that lets go without moving opens its action sheet (Open
  record, Select, Duplicate, Delete, Move to a stack); a hold that moves drags the card where it
  can be dragged, and a swipe still scrolls. A right-click on a desktop opens the same actions as a
  menu at the pointer.
- **Upgrade to database schema 17 (a page for every table).** The server snapshots the database
  first, as for every upgrade, and no value you entered changes. A table with exactly one rich
  text property besides its title uses it as its page; every other table gets a new rich text
  property called "Page" ("Page 2" and so on when the name is taken), hidden in all of its views
  (not in tables in the trash or tables that already have 500 properties). A new table gets one
  too, and a new workspace starts with a top-level project named after it; a workspace that had
  no project gets one the same way. Tables are coloured in turn, each table that has a date
  property called Due, Deadline, Date, When or Start (and a checkbox called Done or Complete) is
  set up for the Home page (Due is taken before Due date, Deadline, Date, When and Start, whatever
  their order in the table; likewise Done before Complete and Completed), and each person gets a first day of the week (Sunday). The
  Airtable-compatible API answers as before, except that a table lists its new Page property and
  a workspace lists its top-level project among its bases, even while that project is empty.
- **Collection settings in the API and MCP.** A table has a `color` (set on create and update;
  the `icon` still works), a page field (`body_field_id`; `POST /api/tables/{id}/body-field`,
  MCP `set_page_field`), a record name, a Home date and a Done checkbox (`PATCH
  /api/tables/{id}`, MCP `update_table_settings`). Listings add each table's `record_count`,
  workspaces their `root_base_id` and projects `is_top_level`; `POST
  /api/workspaces/{id}/top-level` (MCP `set_top_level_project`) chooses the top-level project,
  which can no longer be deleted until another takes its place. Deleting or retyping a page,
  Home date or Done field clears the setting. Saving a record's page with `PUT
  /api/tables/{id}/records/{rid}/page` adds "Page" to a table that has none.
- **Agents know the top level and what a delete leaves behind.** MCP `create_workspace` also
  returns `workspace_id` and `top_level_project`; `list_projects` marks each project's
  `is_top_level`. `delete_workspace` and `delete_project` say what moved to the trash, how to
  restore it (`restore_from_trash` with kind and id) and the date the retention purge erases it
  (`trashed`, `restore_with`, `purge_after`, `retention_days`). The tools that delete for good
  (share links, automations, inbox drafts, invites, members) say "This can't be undone", and
  [docs/mcp.md](docs/mcp.md#destructive-tools-and-what-can-be-undone) lists every destructive
  tool and whether the trash brings it back.
- **One request for Home.** `GET /api/workspaces/{id}/home` (MCP `get_home`) returns what is due
  soon (records of collections with a Home date, from 30 days ago to 7 days ahead in your time
  zone, not marked done), the 10 records most recently created or edited that you can open, and
  your inbox drafts. It reads only projects you can open, never more than 100,000 records, and
  answers in under 300 ms for 20 collections and 100,000 records.
- **Calendar weeks and months in date filters.** `is_within` takes `this_calendar_week`,
  `next_calendar_week`, `last_calendar_week`, `next_calendar_month` and `last_calendar_month`.
  Weeks start on the request's `week_start` (0 Sunday, 1 Monday; a view query, summaries, CSV
  export and MCP `query_view` accept it), else the first day of the week in your profile
  (`PATCH /api/auth/me {"week_start": 1}`, returned by `GET /api/auth/me`), else Sunday;
  automations use their creator's. The earlier `past_week` and `next_week` stay rolling days.
- **Select, delete and undo in every view.** Kanban, gallery, list, calendar and timeline now
  have what the grid had: Shift/Ctrl/Cmd-click to select several cards or rows, ⌘A / Ctrl+A,
  a bar with the count and **Delete**, **Duplicate** and **Clear**, the **Delete** key, and a
  record menu on right-click or the menu key. Deleting several records asks first with the count.
  Moves, edits, new records and deletes can be undone with ⌘Z / Ctrl+Z (redo with ⇧⌘Z, Ctrl+Y),
  and a toast after a delete or a drop has **Undo**. The grid shows **Undo** and **Redo** buttons.
- **New records fit the view.** A record added in a filtered or grouped view starts with the
  values that keep it there (the filter's "is" conditions, the group, stack or lane). One added
  and closed without typing anything is dropped again.
- **Kanban:** drag stack headers to reorder them; the stack menu can rename, recolour, hide (for
  this view) and delete a stack; while dragging there is always a **No value** stack to clear a
  card's value. Person stacks show names, and only people with cards unless **Show everyone, even
  people with no cards** is on. Cards can show more or fewer fields, and covers can be fitted instead of cropped.
- **Calendar:** a **Day** layout; the layout, the date and the first day of the week are kept;
  drag an event onto **Unscheduled**, or press Delete on a focused event, to clear its dates; on a
  phone the unscheduled records open as a sheet under the days.
- **Timeline:** dragging near an edge scrolls the chart; bigger handles on touch screens; swim
  lanes list every choice or collaborator, not only the ones in view; Alt+Shift+arrows move the
  start, T jumps to today, + and − zoom, [ and ] page, and a bar can be added to a lane from the
  keyboard. Draw a dependency by dragging from a bar's dot to another bar (or L from the
  keyboard), and select an arrow to remove it; broken dependencies are named on the bar.
- **Gallery and list:** arrow keys move between cards and rows; drag to reorder when the view has
  no sort (and between groups of a list, which changes the group's value). A new gallery uses the
  table's first attachment field as its cover. Cards say "+N more" when they hold more fields than
  they show.
- **List rows can be ticked off and nested.** Choose a **Prefix field** (a checkbox, single
  select or one-person field shown at the start of each row and editable there) and **Sub-items**
  (a link to the same table): rows nest under their parent, Tab and Shift+Tab indent and outdent, and
  parents fold.
- **Forms:** show a question only when an earlier answer matches (**Show if**); headings and text
  between questions; field defaults are filled in and field descriptions are used as help; a public
  form link can prefill and hide fields with `?prefill_<Field>=…&hide_<Field>=true`; **Notify me
  of new responses** (and other people) by notification, and email when the server can send it;
  the redirect after submitting can include `{record_id}`. Enter submits **Fill in form** from a
  one-line field and ⌘/Ctrl+Enter from anywhere; an error moves focus to the field.
- **Agents and the API:** `move_records` and `duplicate_records` (`POST …/records/move` and
  `…/records/duplicate`), a `position` (`top`, `bottom`, after or before a record) on
  `create_records`, and `from` / `to` on `query_view` for what a calendar or timeline shows in a
  date range. Form `show_if`, blocks and `notify_user_ids`, and the new kanban and list settings,
  are set with `update_view`.

### Security

- **Query bodies from strangers are bounded.** `POST /api/public/shares/{token}/query` takes a body of
  at most 64 KiB (413 beyond) and filters are read in one pass that stops at 8 levels or 5,000 items,
  where a nested filter in a 4 MB body could make the server hold gigabytes of copies before the token
  was even looked at. A filter's id-list operand (`is any of`, `has all of`, ...) is limited to 1,000
  ids and 5,000 per filter, and is compiled to a set once instead of being rebuilt for every record.
  `aggregate_records` and `POST /api/tables/{id}/aggregate` take at most 23 `sort` entries and ignore a
  key named twice. `list_icons` refuses a `query` over 200 characters (the same bound applies to the
  icon "did you mean" search). Changing a rich text property's type no longer indents nested lists
  without limit, which let one 100,000 character cell need gigabytes. All stored filters and view
  configurations load as before.
- **A share link's visitor can no longer change the view's filter.** `POST /api/public/shares/{token}/query`
  used to let a `transient.filter` replace the saved filter, which showed every record of the collection
  in the shown properties, including the ones the filter hides. It now answers 400 for a `transient`
  with a `filter`; sorts, groups, row colors, summaries and `search` still work on top of the saved
  filter, and the shared view in the web app only ever sent sorts. Signed-in callers are unchanged.
  Mentions (`@[Name](usr...)`) in the rich text of a shared view now read `@Name`, so a share link no
  longer tells a visitor who was mentioned by user id. A public form accepts only files visitors uploaded
  to it anonymously (in a file property or linked in rich text), not any other file of the folder.
- **Everyone is signed out once after this update when OpenBase is served over https.** The
  session cookie is now named `__Host-ob_session` (the browser then refuses to let a sibling
  subdomain set it); sessions issued under the old name are no longer recognised. Over plain
  http the cookie keeps its name. Sessions that sit unused for 14 days now end, on top of the
  30-day maximum; with plain http that also signs out anyone whose session was started more
  than 14 days ago, because the time of last use was not tracked before.
- Cookie-authenticated requests whose `Origin` (or `Referer`) is not the public URL are refused
  with 403, as the documentation always said. Bearer-token clients and anonymous form posts are
  unaffected. If you reach OpenBase at an address other than `OPENBASE_PUBLIC_URL`, requests
  from that address are now refused: set the URL to the address people use. (The web client's dev
  server proxy sends the configured public URL as the origin.)
- **Share-link passwords:** new passwords need at least 8 characters (existing ones keep
  working). A link locks for 15 minutes after 100 wrong guesses in an hour from all addresses
  together, and checking those passwords no longer competes with sign-in for hashing slots.
  Anyone who knows a link can use up those guesses on purpose and so lock its password prompt
  (for people already viewing it too); that is accepted, see
  [docs/security.md](docs/security.md#accepted-risks).
- The server sends `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Resource-Policy: same-origin`, and `Strict-Transport-Security` (one year) when
  the public URL is https (without `includeSubDomains` or `preload`). A popup that another
  origin opened onto OpenBase no longer has a `window.opener` link back to it, except on the
  sign-in and consent pages (`/oauth/authorize`, `/login`, `/login/2fa`, `/oauth/consent`),
  which a connecting MCP client's popup walks through and which therefore carry no opener
  policy.
- **Agents and the API see the right caller address.** Requests an agent makes through the
  `api_request` tool now carry the address of the connection to `/mcp` (or, behind a trusted
  proxy, the address the proxy saw), so per-address limits and the audit log name the real caller
  instead of the server itself.
- **Dependency security updates.** The Rust and web dependencies were updated to versions
  without known fixable advisories (rustls, rustls-webpki, tokio, time, pulldown-cmark,
  webauthn-rs 0.6.2, undici, body-parser, qs and others), the unused `ammonia` crate was
  removed, and the grid library's minimatch is forced to a fixed version. One advisory has no fix
  and is ignored on purpose, with its reason and a re-check date (RUSTSEC-2023-0071, `rsa`,
  reached only to verify passkey signatures); see
  [docs/security.md](docs/security.md#accepted-risks).
- [docs/security.md](docs/security.md) now says what the code does after these changes and lists
  the accepted risks with their reasons: share tokens stored readable, `style-src 'unsafe-inline'`,
  the ignored advisory, and that anyone who knows a password-protected link can lock its
  password prompt for 15 minutes by guessing wrongly 100 times.

### Changed

- **The property dialog.** Adding and editing a property is a dialog on a desktop and a full-screen
  sheet on a phone, with the type list in groups, a one-line description for each type, arrow-key
  movement through the list and, on a phone, a bottom sheet of its own. Changing a type says how many
  values it clears: every value when a property becomes computed or a link (the server clears those),
  and up to that many when values are converted one by one; with nothing to take away it no longer asks
  to be confirmed. Retyping the page property says it stops being the page.
- **"Field" reads "property" in the rest of the interface** (and "table" reads "collection" where they
  sat in the same sentence). The API, the MCP tools and stored data keep their names.

- **Every change to a view is a draft until someone saves it.** Filtering, sorting, grouping,
  coloring, hiding or reordering properties, resizing or freezing columns, row height, summaries
  and a layout's own settings (what a board stacks by, a calendar's dates, a timeline's scale)
  now stay on your device, for you, and survive a reload; nobody else sees them, whatever your
  role. A bar under the toolbar says "Showing 3 of 12 clients. These changes are only for now."
  (the count only when the filter changed; it uses the collection's record name) with **Reset**,
  **Update view** and **Save as view**. Update view writes the changes to the view for people who
  may change it (on the default grid, editors and up, for the layout settings only; its filter,
  sort, groups and colors can only become a new view). Save as view, for editors and up, names
  the changes after the filter and offers Only me or Everyone (creators). If the view was saved by
  someone else meanwhile the bar adds "This view changed since you started." and keeps your
  changes. The toolbar no longer saves after a pause, and the "Not saved" and "Locked" badges are
  gone (a locked view's tab still wears a lock). Viewers and commenters can now choose a board's
  stack property, a calendar's date and the like, and color records, for themselves. A form's own
  settings and fields still save as they are made. Old per-device filters and layouts move into
  drafts the first time you open a view. Row colors and summaries drafted in the app are computed
  by the server like saved ones (`transient.row_color` and `transient.summaries`, see
  [docs/api.md](docs/api.md)).
- **A collection has a header, view tabs and a settings screen.** The header shows the collection's
  color mark, its name, how many records it holds (it follows adds and deletes), who is viewing,
  **Share** and a primary **New client** button named after the collection's record name ("New
  record" when it has none); a collection inside a folder shows the folder's name above its
  title, and the description is a muted line under it that creators click to change. The views
  are tabs under it: the default view first, reading "All clients", then the saved views with
  their layout's icon and a person or lock glyph for personal and locked ones. Tabs that do not
  fit go into **More**; a right-click, the menu key or a held press on a phone opens the view's
  menu (rename, duplicate, share, lock, move left or right, delete), and tabs can be dragged
  into a new order. There is no **Add view** any more: a new view comes from **Save as view**.
  Creators open **Collection settings** from the "…" beside the title: name, color,
  description, record name, the title property (the first screen for it), the page property, the
  date Home shows records by and the done checkbox. On a phone the title has a row of its own
  under the header, so a long name is no longer cut off between the buttons, and the settings are
  a full-screen sheet.
- **One bar filters and searches a collection.** It sits under the view tabs, full width. Type
  what you mean ("status done", "amount over 500", "next follow-up this week") and the list
  under it offers the filters your words could mean, most likely first, then a filter on a long
  text property, then "Search every property for …". Enter applies the highlighted one as a chip;
  chips combine with AND. Backspace in the empty field selects the last chip and a second
  Backspace removes it; clicking a chip changes its property, operator or value. **Advanced
  filter**, at the bottom of the list, opens the nested builder for OR groups, and a view whose
  filter uses OR or groups shows as one chip, "Advanced filter, 3 conditions". `/` and Ctrl+F
  focus the bar. Everything it does is a draft, like every other change to a view. The toolbar's
  Filter tool and its search box are gone; on a phone the suggestions sit above the keyboard
  and the editors are sheets.
- **One "View options" button holds every setting of a view.** It sits at the right end of the
  filter bar and opens a panel anchored right (a bottom sheet on a phone). It starts with the
  layouts as tiles (List, Grid, Board, Calendar, Gallery, Timeline and Form; a kanban is now
  called a Board) and, right under them, the chosen layout's own settings: what a board stacks
  by, a calendar's dates and week start, a gallery's cover, a timeline's start, end, swimlanes
  and dependencies, a list's prefix and sub-items, and for a form a button that opens the form
  builder. Sort, Group, Color and Properties are rows that say what they are set to ("Next
  follow-up, soonest", "By Status", "4 shown, 1 hidden") and open a screen of their own with a
  Back button; Properties also holds the description property and how many properties a card
  shows. A grid adds Row height and a new **Wrap headers** switch that sets long property names
  on two lines. The footer has the layout's switches (Hide empty stacks, Fold all groups), Add
  property (creators) and Download CSV. Everything in it is a draft, except a form's own
  settings. Picking another layout shows the same records in it and keeps the panel open. The old
  toolbar and its More menu, and the floating Add record button, are gone: New record is in the
  collection header (the + on a phone), Add property and Download CSV are in View options, and
  the grid's Collapse all and Expand all became the Fold all groups switch. Color is no longer
  switched off on a collection's default view (as a draft it can become a new view).
- **The sidebar is rebuilt around one workspace.** It starts with the workspace switcher (the
  workspace's color, its name and "Switch workspace"; its menu begins with the OpenBase mark,
  lists every workspace and ends with the workspace's own actions), "Search everything", Home,
  Notifications and Automations, then the collections (the top level's, with their record counts)
  and the folders, and ends with History, Trash, Workspace settings and your account. Clicking a
  folder folds it, kept on each device; a collection opens in the view you used last. Collections,
  folders and workspaces show a color mark, never an icon or a letter, and their menus offer a
  color instead of an icon. A "+" beside Collections adds a collection, one from CSV or a folder.
  Folder menus gain "Use as top level"; collection menus no longer hold Edit schema or Add view
  (views are made from the view list). Ctrl+\ folds the sidebar (focus moves to the header's
  button when it was inside), and the Inbox is no longer in it; old /inbox links go to Home. A
  collection's record count follows your own adds and deletes within a second or so. The
  workspace's Automations page lists the top level and every folder, each with a New automation
  link. A folder that no longer exists opens a "Folder not found" screen inside the sidebar.
  Workspace settings no longer offers a workspace icon.
- **The phone has a bottom navigation instead of a menu drawer.** Home, Collections and
  Notifications are three tabs at the bottom of the screen (with the unread count), above the
  home indicator; the bar hides on record pages. The Collections tab is a screen of its own with
  the workspace switcher, your collections and folders, History, Trash, Workspace settings and
  your account. Notifications is a full screen too: each row shows who, one sentence, a chip for
  the record and the time, with Mark all read at the top (it was "Mark all as read"). Every phone
  screen has a 56 px header with 44 px buttons: Home has the workspace switcher and your avatar,
  which opens your profile menu as a sheet; other screens have a back link that names the
  screen it leads to. The workspace switcher opens as a sheet on a phone, and so do a row's "..."
  menus and the "+" beside Collections. The Collections tab follows other people's changes live.
  With no workspace yet, the first-run screen has your avatar, so Sign out stays reachable. Home,
  the Collections tab and every collection have a search button in the header.
- **Search is a command palette.** Ctrl K or Cmd K (or the search button, or the sidebar's
  "Search everything") opens it from anywhere; it fills the screen on a phone. Results come in
  groups: records (each with its collection's color mark), collections, folders, views and
  workspaces, and comments last. Type "new record in", "new collection", "home" or "settings"
  and the actions that fit appear below the results: "New record in Clients" (for collections
  you can add to), "New collection", "Go to Home" and "Open settings". It narrows to Everywhere,
  This workspace or This folder. Arrow keys move through the list, Enter runs the highlighted
  row (and waits while the results are for older text), and Escape closes it and puts focus back
  where it was. The record page's editor keeps Ctrl K for links while it has focus. The extra
  "other workspace or project" picker is gone.
- **Text edits no longer flood record history.** Repeated edits of one text or rich text cell by
  the same person fold into one history entry while it is under ten minutes old: it keeps the
  first old value, the latest new value and the time of the latest edit. Other fields, other
  people and older entries still get their own entry. Typing and then undoing inside that time
  leaves no entry at all.
- **Notifications:** the unused "invite" kind is gone from the app and the docs (the server never
  wrote one). The MCP `create_view` description now says personal views need the editor role.
- **The Docker image runs on Debian 13** (a current ffmpeg) with its packages upgraded at build
  time, and the base images are pinned by digest. The release and CI builds use Node 26 (the
  active LTS line) and one exact Rust version, 1.99.1, named in `rust-toolchain.toml`. Building
  from source needs that Rust version (at least 1.89), not "stable".
- CI also runs `cargo deny check`, `npm audit --audit-level=high`, a gitleaks scan and a Trivy
  scan of the image, and so does `scripts/check.sh` for the first two. Contributors need
  [cargo-deny](https://github.com/EmbarkStudios/cargo-deny) installed.
- **Delete deletes.** Delete or Backspace on selected grid rows now deletes the records (with
  Undo) instead of emptying their cells; clearing a large range of cells asks first. On the
  timeline, Delete on a selected bar deletes its record; **U** (or dragging it onto
  **Unscheduled**) takes it off the timeline as Delete did before.
- **Editors can restore what they deleted.** Editors see the records they deleted themselves in
  the project's trash and can restore them (`list_trash` and `restore_from_trash` too); everything
  else in the trash still needs the creator role.
- A public form's submit answers `{ok: true, record_id}`.
- A form can no longer make a link or person field required when its public link cannot ask it.
- `create_view` and `update_view` refuse calendar, timeline and kanban settings that name a field
  of the wrong type (an end equal to its start, a dependency that is not a link to the same
  table…). A kanban `stack_order` read from `get_view` (with `Uncategorized`) can be written back.
- A shared (public) board follows the view's stack order, hidden stacks, card field count and
  cover fit. Person stacks keep their natural order there, since their keys are user ids.

### Fixed

- Switching a view to the Form layout shows the changes bar like any other draft, so Reset and Save as
  view are there and a form can be made from it. Reset in "No clients match these filters" goes back
  to the view as it is saved instead of dropping the view's own filter. Download CSV says "Saved view
  only" while there are unsaved changes, because the file is the saved view's.
- A phrase in the filter bar keeps what it says: "till Nov 14", "not by Friday" and "since Friday"
  read as dates before, after and back, a lead word such as "before" or "by" that no operator took
  is left unread, "Jan 5" near New Year is the nearest one, and a choice named "None" or "Not set"
  is the choice. "3/4 complete", "score 7/10" and "step 2/5" are not dates in the capture box,
  "3/4/85" is 1985, and a dashed date, a year range or an ISBN is not guessed as a phone number.
  The CSV importer keeps a currency or a percent with more than 15 digits or 8 decimals as text,
  reads HTTP:// in capitals as a link, and no longer takes "mailto:a@b.com" for an email address.
- The view tabs point at the page under them, the Ctrl+F of the filter bar stays out of a dialog,
  Escape from Save as view, Reset and Clear selection leave focus on the page, a Board's "+ New
  record" keeps its height and contrast, and filter chips, switches, property handles and List
  checkboxes are 44 px targets on a phone.
- On a phone the select box of a Board card or a Gallery card no longer covers the first letters of
  its title (it sits in the top right corner, and the title leaves room for it), and the select
  boxes of cards and List rows are 44 px targets. The List's number no longer runs into its box.
  The grid's last header reads "Add property", the timeline's Today label no longer sits on top of
  a date label, and the month of the calendar scrolls on a phone when the Unscheduled sheet leaves
  its days too little room, instead of letting "+1 more" spill into the next week.
- Pickers in forms and the record panel show a pick at once; Tab and Enter commit and move on in
  person, link, choice and attachment cells; the rating keys step instead of clearing.
- Pasting a block that includes an attachment column or one bad cell pastes the cells that fit
  and says what was skipped; a pasted name that matches several records is not linked to the
  first one.
- Group headers and summaries in the grid work from the keyboard and stay folded after a reload;
  columns move from their menu and from **Hide fields**.
- The record panel's previous and next go past the rows loaded so far and skip folded groups.
- A calendar event with a date-only end no longer grows a day when dragged by hours.
- A timeline drop from **Unscheduled** keeps an existing end date; records with only an end, or an
  end before the start, are drawn and can be repaired by dragging; a failed drop puts the record
  back; moving a bar to another lane never overwrites the date it was dragged to; the today line
  moves at midnight.
- A form's builder is read-only for editors while its public link is on, instead of saving and
  snapping back; removed questions keep their settings when added back; the preview no longer
  creates choices or uploads files; switching between two forms of a table starts the second
  one fresh.

## [0.8.0] - 2026-10-21

### Added

- **Search from every page.** "Search everything" is now in the top bar everywhere, including
  inside a project, its automations and on every settings page; ⌘K / Ctrl+K jumps to it. When the bar
  has no room for the box (a phone, or a project with a long path) it is a search button at the
  bar's right end that opens the same search. Once you type, chips narrow the results to **This
  project** or **This workspace** (or any other one, from the picker). Each result shows where your
  text matched: the match is highlighted in names, and a record found by another field shows that
  field's name and the words around the match ("…Steven will be in charge of **mark**eting. That
  may…"), as plain text: rich text and comments without their Markdown, a mention as @Name.
  `GET /api/search` takes `workspace` and `base`, and returns `name_matches`, `snippet_matches`
  and the matching field; agents get the same with the new MCP tool `search_everything`.
- **Put things in order.** Drag workspaces, projects and tables in the menu to reorder them (on a
  phone, hold a finger on a row first). Each moves among its own siblings: a project stays in its
  workspace. The "…" menu of each row has **Move up** and **Move down** too, and so does a view's
  menu in the view list (a view moves among the shared ones, or among the personal ones). The
  order of workspaces is your own; the order
  of projects, tables and views is everyone's, and changing it takes the role that renames them
  (an editor orders their personal views). Inbox, Notifications, Automations, History and Trash
  stay where they are. Agents reorder with `reorder_workspaces`, `reorder_projects`,
  `reorder_tables` and `reorder_views`, or the `POST …/reorder` routes.
- **@mention people in rich text.** Type `@` in a rich text field, an Inbox draft or a comment to
  pick someone who can see the project; the mention shows as a chip. They get a notification
  ("… mentioned you in …", opening the record) once the text is on a record they can see: when the
  cell is saved or the comment posted, or when the draft is filed. A draft notifies nobody, saving
  again notifies nobody twice, and you are never notified of your own mentions. Mentions written by
  agents, the API, imports and automations (`@[Name](usrXXXX)` in rich text) notify the same way.
- **Pick the app's colour.** The account menu's **Appearance** now has a **Color** row with the
  ten colours projects and workspaces come in. The one you pick becomes the app's own colour in
  light and dark mode alike: buttons, the selected row in the menu, the active view, switches and
  checkboxes, badges, the grid's selection and your own avatar are filled with it, always with
  white text (the lighter colours are deepened just enough for that), and pink is a true pink.
  Hovers are a light wash of it, short of a selection's fill, and a card's border takes it under
  the pointer. Links and other coloured text use it too, a shade darker on a light page (or
  lighter on a dark one) only where the colour itself would be hard to read. The page, cards, the
  menu and the top bar are plain greys in both themes. Every colour keeps text readable (WCAG AA
  contrast). The choice is saved on your account, so it follows you to
  other devices and is there from the first moment a page loads. Blue is the default. Agents set
  it with `api_request PATCH /api/auth/me {"accent": "teal"}` (`""` for blue).

- **Send feedback** from the account menu: it opens the project's GitHub Discussions in a new tab.
- **Take a bar off the timeline.** A click now selects a timeline bar (a double-click or Enter opens
  its record; on a phone a tap still opens it). **Delete** or **Backspace** clears a selected bar's
  dates, and so does dragging a bar onto the **Unscheduled** column, which lights up to take it; the
  record goes back to the unscheduled list.
- **Undated records beside the timeline.** Like the calendar, the timeline has an
  **Unscheduled** column on the right (open on a desktop, folded or opened as you like, remembered
  per view) listing the records without a start date; drag one onto a lane and a day to date it
  there, in that lane. The footer no longer counts them.
- **A timeline's left column fits its names.** It starts just wide enough for the longest lane or
  record name, and its divider can be dragged (or moved with the arrow keys) to widen or narrow it,
  saved with the view; a double-click fits it to the names again. Agents set it as
  `timeline.label_width` with `update_view`.
- **Group by day, week, month, quarter or year.** A group level on a date (a date field, created
  or last modified time, or a formula or lookup that gives a date) has a granularity in the Group
  tool, by day unless you pick another. Headers read "October 21, 2026", "Week of October 19,
  2026" (weeks start on Monday), "October 2026", "Q4 2026" or "2026", follow the level's oldest or
  newest first, and records without a date share one "No date" group. Date-times fall into the
  period of the viewer's time zone, or the field's own zone when it has one. The grid and the list
  view group this way; a record added inside a group starts on the period's first day. Agents set
  `granularity` on a level of `groups` with `update_view` or `PATCH /api/views/{id}`.

### Changed

- **Colours where they mean something.** A kanban stack, a list group's heading and a timeline
  swim lane's name are filled with their choice's colour instead of carrying a dot, and a swim lane
  takes a faint wash of it behind its bars. Coloured timeline bars lose their dot too; bars without
  a colour are plain grey rather than the app's colour. In the grid, **Color by** marks each row
  with the bar at its start only; its cells keep the grid's own background instead of a tint.
- **The toolbar says what is on.** Each view type's own settings (what a kanban stacks by, a
  calendar's dates, the cards' cover and description) are behind one **View** button. Tools that
  are on name what they do, as Sort and Filter did: **Color by Team**, **Tall rows**, with a plain
  grey fill rather than the app's colour, in the normal weight (not bold); **More** is marked only when a tool that is on has moved
  into it. The search box shows its shortcut, ⌘K or Ctrl K.
- **Tighter layout.** Grid, list and timeline views run edge to edge under the toolbar, without a
  frame around them; values sit closer to their names in the record panel and on cards; the top
  bar's path is plain text, the open table's name in bold and the app's colour. The calendar's
  and the timeline's arrows sit either side of the dates they step through.
- **One button for the views.** The view toolbar starts with a single button, filled with the
  app's colour, showing the open view's icon and name; it opens a list of the table's views with the
  default grid at the top, a line, then the views, and **Add view** at the end. Several views of
  one type share a row named after the open one (or the first) with how many more there are
  ("Board +2"): a click opens that view, and the "+2 ›" (or hovering) opens a submenu of them all. A right-click on the button, or on a view
  in the list, opens that view's menu, where **Move up** and **Move down** put the views in order.
- **The menu lists tables only.** A project's tables no longer unfold into their views: each is one
  row (with its icon, or a table's), opening the view last used in it, and the open table is
  highlighted; tables sit indented under their project. Views are in the toolbar's view list.
- **Records look the same wherever they are listed.** A linked record in the record panel, the
  records picked in a link field, and the undated records beside the calendar and the timeline are
  all one compact card: the title, a line of description (the view's description field, or else the
  record's first filled text field) and its labels (its filled selects), or a couple of its other
  fields when it has no labels, each on a line after its name ("Tasks", then its chips). Hovering a
  card shows all of the record's fields, with **Open**.
  In the record panel a linked record's card is no longer a button: a click on it edits the field.
  A link field's records stay the same cards while it is edited: drag a card by its grip (or move
  it with the keyboard) to put them in order, and remove one with its ✕ (saved at once, or with the
  rest of an edit in progress); the
  pop-over under them only searches for records to add. In the grid, where the pop-over is the only
  place they show, it lists them the same way above its search. In grid cells, linked records are
  small cards too (a hairline border and the title in the app's colour) instead of grey pills;
  hovering one shows the record's preview, which the pointer can move into to scroll it or press
  **Open**. Record previews wait while a list or the grid is scrolling (cards passing under a still
  pointer no longer pop them up), and one already open goes when the list under it scrolls. Editing a link cell opens it out into a
  scrollable box of its records as cards (reorder, remove) with the search under it.
- **Linked records among other values are small chips,** as in the grid: on cards, in lists and
  inside a record's card in the record panel (a person's tasks under their name), the first three
  and then "+17 more", which shows them all ("Show less" folds them again). Hovering one shows its
  preview. Only a record's own link fields in the record panel are full cards.
- **History says where a record is in plain text** ("Record in Acme › Project tracker › Tasks"),
  without the workspace's and project's icons.
- **"+3" for what does not fit.** A grid cell of chips (links, choices, people) that runs out of
  room ends with how many more there are, instead of cutting off silently. Counts like this are
  plain text everywhere, never a bubble: after a cell's chips or files (no longer a badge on the last
  file), beside the faces in the top bar, and on a shared row of the view list.
- **The summary row looks like the rest of the grid,** without a grey band; a summary cell takes a
  light wash of the app's colour under the pointer. While picking
  records for a link field, each result shows a little more (two lines of description and a few more
  fields) to be sure it is the right one. The records already picked are no longer cut off when
  there are many: they scroll.
- **Click a field's name to edit it** in the record panel, as with a form's label, and linked
  records and attachments leave room under their cards to click into the field.
- **A plainer side menu.** Only the open table's name is bold: the open project, workspace and
  view, the headings ("Workspaces", "Tables", "Personal") and your name are in the normal weight,
  and the headings in the normal text colour.
- **A project's automations are in its menu,** rather than a row under the project, and a
  right-click on any row of the menu (a workspace, project, table or view) opens its "…" menu.
- **Text and Rich text.** The two text field types are now **Text** and **Rich text**. Text is
  plain text for names, titles, codes and other short values, shown exactly as typed; tick
  **Multiline** to keep line breaks (an address). Rich text is what was "Long text" with
  formatting on: Markdown with headings, lists, links, tables, files and @mentions, always
  multiline, with no options. Their descriptions in the field picker, and in the tools agents use
  to choose a type, now point notes, summaries, descriptions, articles and posts to Rich text.
  Changing a field between the two keeps what it shows: rich text becomes the plain text it reads
  as (formatting removed, mentions as @Name, lines kept), and plain text becomes rich text without
  turning `*` or `#` into formatting. Turning Multiline off joins each value's lines with spaces
  (the field dialog warns first, and agents must confirm). CSV import gives long or multi-line
  columns a multiline Text field.
  **Upgrading** (schema version 14) renames the stored types: single line text becomes Text, long
  text with formatting on becomes Rich text, and long text with formatting off becomes Text with
  Multiline on, so every field shows its values as before. **API:** the type names are now
  `text` (options `{multiline, default?}`) and `rich_text` (options `{}`); the old names
  `single_line_text` and `long_text` are still accepted on input (REST, MCP), and `long_text`
  always means `rich_text` now. Responses use the new names. In `/api/v1`, Text is
  `singleLineText` or `multilineText` and Rich text is `richText`.
- **Comments are rich text.** The comment box is the rich text editor of rich text fields:
  headings, lists, links, code, tables and @mentions, and files for those who may upload them.
  Existing comments are converted once on upgrade (schema version 13) so they read as before.
  Agents and the API write comments in Markdown.
- Date group headers read as full dates ("October 21, 2026") whatever the field's date format,
  and the empty group of a date field is called "No date" instead of "(Empty)".

### Fixed

- **A list view shows every field you show.** A row listed only its first three filled fields, so
  turning more on in **Hide fields** seemed to do nothing; now it shows each visible field that has
  a value (empty ones are left out to keep rows short).
- **Folding a group in the grid** no longer leaves the rows that move up blank until a scroll: the
  records now shown there are loaded straight away.
- A task list's checkbox sits beside its text again in rich text editors, instead of on a line of
  its own above it.
- A click on the edge between two grid columns no longer shrinks the column to its narrowest; only
  a drag resizes it, and a double-click still fits it to its contents.

## [0.7.0] - 2026-10-19

### Added

- **Every table has a default grid.** A plain grid of all its records, always there, shown as the
  first icon of the view toolbar (before a divider) rather than among the views. Its field order
  and hidden fields are the layout of every record of the table: the record panel, linked-record
  cards and previews follow them, whatever view a record is opened from. It cannot be deleted,
  renamed or locked, and keeps no filter, sort, grouping or colours: the ones you set there are
  yours alone, kept on this device. **Edit schema** in a record's "…" menu and in a table's opens
  it. A new table starts with only its default grid. Agents see it as `is_default: true` in
  `get_project_schema` and change the layout with `update_view` on it.
- **Files show what they hold.** A file's tile is now its preview wherever files are listed (grid
  cells, the record panel, the file editor, cards, share pages, the Inbox and rich text): an image
  itself, a PDF's first page, a video's first frame with a play mark. A file without one keeps its
  type's tile ("DOCX"). A card's cover can be a PDF's first page or a video's frame too. The v1
  API's `thumbnails` cover PDFs and videos as well.
- **Put files in order.** Drag a file by its handle in the file editor (or move it with Space and
  the arrow keys) to reorder an attachment field.
- **Linked records you can read and open.** In the record panel a link field's records are cards
  with their title and the first few filled fields of their table's grid. Click one to open it in
  the panel, with **Back to …** to return (the browser's back works too, step by step). Hover a
  card, or hold a finger on it, to see the whole linked record, so why it is linked is clear
  without leaving the record. The link picker shows the same fields under each result and finds
  records by them, and its results preview the same way. Agents read several records at once
  with `POST /api/tables/{id}/records/get`; the lookup route takes `fields` to search more than
  the name.

### Changed

- **Adding is in the menus.** "Add view" moved from the menu's view list into the table's "…"
  menu, and "Add table" into the open project's "…" menu. Every view but the default grid can now
  be deleted, the last one included.
- **A workspace's or project's name in the menu folds it**, like its chevron, instead of opening a
  page; opening a table no longer unfolds its views.
- **New views are named after their type** ("Kanban", "Calendar"), without "view".
- **Add floats at the bottom right on a desktop too**, as on a phone, leaving the toolbar to the
  view's tools.
- **Tall grid rows** centre their chips and files like their text; file tiles grow with the row
  and count the files that do not fit ("+2").
- The top bar's workspace, project and table share one size, weight and colour, and the menu's
  scroll shadow is lighter.
- **Upgrading:** the database moves to schema 11, which gives every table its default grid with
  the layout of its first shared grid view (existing views stay as they are). A snapshot of the
  old database is written to `backups/` first. Video previews need ffmpeg: the Docker image now
  includes it (so it is larger); with the plain binary, install ffmpeg (`apt install ffmpeg`) or
  point `OPENBASE_FFMPEG` at it. PDFs and videos stored before get their previews in the
  background after the upgrade.

## [0.6.0] - 2026-10-19

### Added

- **History: what changed lately, across every project.** A new **History** page (in the menu
  above the Trash, and in each workspace's and project's "…" menu) lists the changes and comments
  on records in everything you can open, newest first or oldest first. Activity on one record is
  grouped into a card with the record, where it lives (workspace, project, table) and what each
  person did, with how long ago and the exact time on every item and a heading for each day.
  Narrow it by workspace, project, person, or kind (changes, new records, deleted, comments); the
  filters are in the address, like the Trash. Agents get the same feed from the MCP tool
  `list_activity` (filters by name or id) and the REST route `GET /api/history` (see
  [docs/api.md](docs/api.md)); an API token limited to some projects sees only those.
- **The Inbox: a place to write things down first.** The home page is now a capture box, like the
  start page of an AI chat: give it a title, write a note in rich text, attach files, or any of
  these. It is kept as a draft (only you see your drafts, listed below the box) until you choose
  **Save to…** a project and a table. The box then turns into that table's form: the title goes
  into its primary field, the note into a long text field you choose (or into the new record's
  first comment), and Save adds the record. Agents have the same inbox through the new MCP tools
  `list_inbox`, `add_to_inbox`, `update_inbox_item`, `file_inbox_item` and `delete_inbox_item`, and
  the REST routes under `/api/inbox` (see [docs/api.md](docs/api.md)). A draft holds up to 20 files, and the files waiting in one person's
  drafts can take up to 200 MB (`OPENBASE_MAX_INBOX_MB`). API tokens limited to some projects
  cannot use the inbox.
- **Rich text you can see while you write.** Long text fields with formatting turned on are edited
  in a visual editor: headings 1 to 6, bold, italic, strikethrough, code, links, bulleted,
  numbered (starting at any number) and task lists with indenting, quotes, callouts (note, tip,
  important, warning, caution), code blocks, tables you edit in place and dividers, from a toolbar
  or by typing Markdown shortcuts. What is stored is still plain Markdown (callouts use GitHub's
  `> [!NOTE]` syntax), so agents, the API and CSV exports see the same text as before. The button
  at the bottom right of the box opens the editor full screen; plain long text gets the same
  button.
- **Pictures, video, sound and files in rich text.** Upload, paste or drop a file into a rich text
  field and it shows as a block of its own, centred, with an optional caption and alt text. The
  files are as private as the record: only people who can open it can load them. Images from
  other sites are never embedded (they are kept as links), so opening a record never fetches
  anything from elsewhere.
- **Search finds comments too**, below the records, with who wrote each one and on which record;
  picking one opens the record.
- **A right-click on a view's button** (or a press held on it, on a phone) opens that view's menu:
  rename, duplicate, share, lock and delete, as on its row in the menu. It works on views inside a
  shared button's list and in "…" too.
- **See who is here.** The faces at the top of a project are the people viewing it right now; the
  others who can open it are one grey "+N". Agents can ask through
  `GET /api/bases/{id}/presence`, and every event stream starts with the current viewers.
- **Colours for workspaces and projects.** Choose one when you create a workspace or a project,
  and change it later from its "…" menu or the workspace settings. MCP `create_workspace` and
  `rename_workspace` take a `color` too.
- On a computer, click the icon beside the table's name in the top bar to change it. Tables
  without an icon of their own show a sheet.

### Changed

- **Bases are now called projects**, everywhere you read them: the app, the intro, the docs and
  the MCP tools (`list_projects`, `create_project`, `get_project_schema`, … with `project_id`).
  The old MCP names and `base_id` keep working, so connected assistants need no change. The REST
  API, the v1 API and ids are unchanged (`/api/bases`, `app…`).
- **One menu for everything.** The sidebar shows the same tree on every page: your workspaces, the
  projects in each, their tables and views. Expand and collapse any part (remembered on this
  device), and reach what the workspace page, the pickers and the menu's footer used to hold from
  each row's "…" menu. The workspace page and the workspace and table pickers in the top bar are
  gone; the top bar names where you are (`Workspace / Project / Table`).
- **An open record shows its values as they read**, compact, with nothing to type into until you
  click (or tap) a value; then that one field becomes its editor. Escape ends the edit without
  closing the record, and tabbing into a rich text field puts the cursor in its text.
- **Tables open where you left them.** Tapping a table opens the view you last used in it on this
  device, and tapping a project opens its last table.
- **Views as buttons.** The toolbar shows a button for each view of the table, with its name while
  all of them fit; when they do not, each is its view type's icon, and views of the same type
  share one button that lists them.
- **An open record fills a phone's screen**, and shows "Saving…" and "Saved" as your changes are
  saved. Long text is saved as you type, not only when you leave the field. Its link button is now
  Share, which opens the phone's share sheet where there is one.
- The old Inbox, with mentions and other alerts, is called **Notifications**, below the new Inbox.
  The intro has a step about the Inbox.
- **Importing a CSV file makes a table**, since a file holds one table: "New table from CSV…" in a
  project's "+ Add table" menu, or "Import a CSV" in a new, empty project. Workspaces no longer
  offer "Import a spreadsheet", which made a whole project from one file.
- Every item of the profile menu has an icon.
- The toolbar's Add button looks like the other buttons instead of taking the project's colour.

### Fixed

- **A swipe that starts on a button scrolls instead of opening its menu.** On a phone every menu
  now opens on a tap (a finger that lifts where it touched down); a mouse and the keyboard open it
  as before, and so do screen readers. In an open record on a phone, dragging the Comments and
  History tabs no longer scrolls a panel inside the record on its own.
- **Swiping scrolls kanban boards and timelines instead of dragging what it crosses.** On a touch
  screen a card or bar is dragged after pressing and holding it for a moment (a quarter of a
  second); a finger that moves sooner scrolls. Swiping across empty timeline lanes no longer starts
  drawing a new record either. A quick tap still opens the record; a mouse drags as before.
- Tapping blank space in a grid view always clears the selection. On a phone it would sometimes
  select the first row's primary cell instead, toggling on and off over a few taps (the grid
  selects its first cell when it takes the keyboard focus, and the tap's focus was mistaken for
  that).

## [0.5.1] - 2026-10-17

### Added

- **MCP agents keep a table's views up to date.** The server instructions and the table, field and
  view tools now ask agents to set up the views a table's purpose calls for (a calendar for dated
  records, a kanban by status, a form for intake, grids sorted or filtered for common questions),
  named for what they show, and to read data through a fitting view with `query_view`.
  `create_table` and `import_csv` (new table) return a `views_note` saying so; `create_field`
  returns one naming the views the new field may concern, including the forms that do not ask for
  it yet. `delete_field` and type changes in `update_field` return `views_to_check`: every view
  whose filter, sorts, grouping, row colours, form or a setting such as a calendar's date field or
  a kanban's stack field used the field, and where.

### Changed

- The MCP server instructions were tightened to stay under 2048 characters, the length Claude
  Code shows.
- **Menus and popovers fit the screen.** Every menu, submenu and popover is at most as tall as the
  room between its trigger and the edge of the screen (clear of the iPhone home indicator) and
  scrolls past that. On a phone the table and view picker runs to the bottom of the screen, and an
  unfolded "Add view" scrolls inside it instead of being cut off.
- **The compact layout runs up to 1024px wide.** Phones in landscape and tablets in portrait keep
  the phone layout (views edge to edge, the menu in a drawer) instead of switching to the desktop
  one with its margins and docked menu at 768px.
- **The whole menu above the profile scrolls.** Members, Automations and Trash are no longer fixed
  at the bottom of the sidebar: a long menu pushes them down and you scroll to reach them (a short
  one still keeps them at the bottom). A shadow at the top or bottom edge shows there is more to
  scroll that way.
- MCP `create_view` and `update_view` accept `description_field_id` inside `kanban` (where 0.4.0
  had it), `gallery`, `calendar` or `timeline` and move it to the top of the config, where it
  belongs; the config help says so.

### Fixed

- On a phone, a grid view that opens with its primary column already unpinned no longer leaves the
  pin button floating in place while the column scrolls away; the button moves with its column.

## [0.5.0] - 2026-10-17

### Added

- **Every view can read a description under each record's title.** Kanban, gallery, list, calendar
  and timeline views have a "Description" choice in their settings (list views get a "Description"
  tool of their own): any text field, chosen per view, so no table has to have one. Kanban and
  gallery cards show an excerpt of up to three lines under the title, list rows two; pointing at it
  shows the whole text (rich text as formatted markdown). Calendar events and timeline bars have
  room for the title only, so pointing at them shows the description. On a phone, tapping opens the
  record as before. The description field is not repeated among the card's or row's other fields.
- **Phones can unpin the grid's primary column.** A pin button in the primary field's header lets
  it scroll away sideways; it is pinned by default and remembered per view on each device.

### Changed

- **The description setting moved from kanban to the view.** `kanban.description_field_id` is now
  `description_field_id` at the top of the view config (REST API and MCP), and shared views report
  it as `description_field_id`. Existing boards keep their choice: the database migration moves it.
- On a phone, a submenu that has no room beside its menu ("Add view" in the table and view picker)
  unfolds its choices in place instead of opening off the left edge of the screen.

### Fixed

- On iPhones, the item count, the app header and the floating "Add" button keep clear of the
  rounded corners, the notch and the home indicator (the page now asks for the screen's safe areas).

## [0.4.0] - 2026-10-16

### Added

- **Kanban cards can show a description.** The board's "Stacked by" settings have a new
  "Description" choice: a text field (single line or long text, or a formula, rollup or lookup that
  gives text) shown under each card's title as plain text, up to three lines before an ellipsis.
  That field no longer repeats as a label/value row on the card. Rich long text is shown without
  its markdown. Shared boards show it too, unless the view hides the field. The setting is
  `kanban.description_field_id` in the view config (REST API and MCP, which takes the field name).

### Changed

- **The view toolbar makes room for itself.** When the window is too narrow for every tool, Filter,
  Sort, Group, Hide fields, Color and Row height move into More, from the right end first, and come
  back as the window widens. Add field and Download CSV always live in More.
- The pictures on an empty base and on a view's "choose a field" screen no longer move.

### Fixed

- The grid grows to fit its rows when a horizontal scrollbar shows (macOS set to always show
  scrollbars, Windows, Linux) instead of scrolling while the page still has room.
- Person chips and select pills are no longer cut off at the top and bottom on kanban and gallery
  cards and in lists.

## [0.3.0] - 2026-10-16

### Added

- **Select choices get meaningful default colours.** A choice created without a colour (when
  creating a select field, converting a field or typecasting a record value) is coloured from its
  name when it is a common severity or status word: Critical and Urgent red, High orange,
  Medium and In Progress yellow, Low and Done green, Open and To do blue, Cancelled gray. Other
  names still cycle through the palette. Choices given as `{name, color}` keep their colour (the
  `create_field` MCP tool, `field_types` and the REST API all accept it).

- **Aggregate records (group-by).** `POST /api/tables/{id}/aggregate` and the MCP tool
  `aggregate_records` count, sum, average and take the minimum or maximum of a table's records,
  optionally grouped by up to 3 fields, computed on the server in one pass instead of paging every
  record to the client. Records can be narrowed with a `view` and/or a `filter_by_formula`, like
  listing them, and the same permissions apply (Viewer; read-only tokens may call it). Group values
  are names, not ids (select choices, linked records, people), dates are `YYYY-MM-DD`, the empty
  group is `null`; invalid combinations such as a sum of a text field are clear errors. See
  [docs/api.md](docs/api.md) section 5.
- **`create_table` takes a list of fields** (MCP tool and `POST /api/bases/{id}/tables`):
  `fields` has the shape of `create_field` and sets a table up in one call. It is all or
  nothing: every field is checked and, if one is invalid, no table is created and the error
  names it. A lookup, rollup or count may use a link field listed earlier in the same list.
- **`include_empty` for reads.** `list_records`, `search_records`, `get_record` and `query_view` (and `includeEmpty=true` on the REST list and single-record endpoints) return fields with no value as `null`, so a client can infer columns from the records. Default unchanged: empty fields are left out, as in Airtable.

### Changed

- **Every new table starts the same way:** with just its primary field "Name" and a grid view.
  The first table of a base created without `empty` used to get a "Notes" long-text field as
  well; it no longer does, so a script no longer has to check which fields a new table has
  (add what you need with `fields` on `create_table` or with `create_field`). The web app
  already created bases empty, so it is not affected. Existing tables keep their fields.
- **Relative date filters are documented as viewer-time-zone.** `today`, `tomorrow`, `past_week`
  and the other relative modes are calendar days in the viewer's time zone (the request's
  `timezone`, else the profile's, else UTC), so an evening in US Central time still shows
  today's events. The MCP `create_view` / `update_view` descriptions and `docs/api.md`
  (section 6) now say so, and the MCP `query_view` tool takes an optional `timezone`.

### Fixed

- **Send test email with providers like Resend.** Choosing STARTTLS for an implicit-TLS port
  (465, 2465) or TLS for a STARTTLS port (587, 2587, 25) used to leave the test hanging until
  it timed out with a generic message, with nothing reaching the mail provider. Admin > Email
  now keeps port and connection security together, warns about a mismatch, and every failed
  delivery says which server and mode it tried, the real error and, for a mismatch, the fix.
  A server that never answers is reported after 25 seconds. New tests run the real SMTP
  transport against a fake STARTTLS / implicit-TLS server with `AUTH PLAIN`/`LOGIN`.

## [0.2.0] - 2026-10-16

### Changed

- **One access model.** People get access only by being a member of a workspace. Each member
  has one role there and either every base of the workspace (including bases created later) or
  a picked list of bases; owners always have every base. Per-base roles and base-only members
  are gone. A member limited to some bases who creates or duplicates a base gets it on their
  list. `PATCH /api/workspaces/{id}/members/{user_id}` takes `role`, `all_bases` and
  `base_ids`; members carry `all_bases` and `base_ids`; `GET /api/bases/{id}/members` lists the
  workspace members who can open the base (any role may call it); `DELETE` on it takes the base
  off a limited member's list, and `PATCH /api/bases/{id}/members/{user_id}` is removed.
  `GET /api/workspaces` lists only workspaces you are a member of (with `role` always set),
  with `member_count`, `pending_invite_count` and, for each base, `people` (who can open it,
  including pending invites); `GET /api/bases/{id}` adds `people` and `workspace_name`. In
  member listings, callers who are not workspace owners only see the `base_ids` they can open.
- **Invites always join a workspace**, giving every base or a list (`all_bases`, `base_ids`
  on create and in listings). Owners invite from the workspace (every base by default); creators
  invite from a base they can open (that base by default, or other bases they can open; never
  every base, never above their own role). Accepting when already a member adds up the bases
  and keeps the higher role; only an invite whose terms a workspace owner last set without a
  token limited to some bases (from the workspace or from a base) raises an existing member's
  role, so one from a creator or from an owner's base-limited token only adds bases. Upgrading
  (database schema 7) records this on each invite; invites pending at the upgrade only add
  bases for existing members.
  A base-limited API token cannot create an invite to every base or at the owner role. The
  invite page always names the workspace. The MCP tools
  `set_member_role`, `create_invite`, `list_members`, `remove_member` and `list_invites` follow.
- **Upgrading converts existing sharing (database schema 5).** Someone who was only a member of
  individual bases becomes a workspace member limited to those bases, with their highest role
  among them (a single-base owner becomes a creator, because owners always have every base).
  Being a workspace member, they can now see the workspace's member list, and a base-level
  creator or owner becomes a workspace creator, which lets them add new bases to the workspace.
  Bases in the trash (or in a trashed workspace) do not count: access to them goes away, and
  someone who was only on such bases becomes no member at all. Someone who was already a
  workspace member keeps their workspace role on all bases, and **a higher role they were given
  on a single base is dropped** (a workspace viewer who was a creator on one base is now a viewer
  there too). Base invites become workspace invites limited to that base; invites to trashed
  bases are deleted. A snapshot of the old database is written to `backups/` before the upgrade,
  as for every migration.

### Added

- **A first-run intro** to bases, tables, workspaces and the assistant, shown once per account;
  replay it from the profile menu. The setup page is friendlier and no longer asks you to
  confirm the password.
- **A new app shell.** A menu button at the top left opens the sidebar, which you can resize and
  collapse (remembered on each device); on phones it is a drawer. Your profile menu sits at the
  bottom of the sidebar. Home opens the workspace you used last, or offers "Create your first
  workspace".
- **Workspace page** with avatars of who can open each base (dashed for pending invites); on
  phones, Import and New base float at the bottom. A **Members page** sets each member's role
  and the bases they can open.
- **One Share dialog** with two tabs: Invite people and Share a view.
- New bases start empty, with "Create your first table". Tables and their views live in the
  sidebar; the table tabs and the views panel are gone.
- **Inbox** at the top of every sidebar replaces the bell in the header: an unread count, and a
  panel beside the sidebar with your notifications and "Mark all as read". On phones the menu
  button shows a dot while something is unread.
- **Search everything** in the top bar (Ctrl+K or ⌘K) finds workspaces, bases, tables, views and
  records in everything you can open; on phones it is a search button.
- **The sidebar lists your workspaces as a tree.** Each workspace opens into Bases, Members, Trash
  and (for owners) Settings; account settings moved to the profile menu.
- **Inside a base**, the header reads "Workspace ⌄ / Base ⌄": both are menus, and the base menu
  starts with "Workspace home" and holds Rename base and Change icon. Each base's colour tints
  its tile and its Add button; workspaces have solid tiles in their colour.
- **The view toolbar is one row**: the table and view picker, Filter, Sort, Group and Hide fields
  (each tinted and labelled when in use, such as "Sorted by Who"), the view's own setting, a More
  menu (Color, Row height, Download CSV and per-view options), search and Add. Counts read
  "N items".
- **Every view type is redrawn**: the grid sits in a card; kanban stacks end with "+ Add" and their
  count; the calendar has its own header with a Month | Week | List switch and a foldable
  Unscheduled column; the timeline shows one row per record with a fixed name column; the list
  folds its groups; the form builder shows its settings beside a live preview. Kanban, calendar
  and timeline ask for their field on a full "choose a field" screen.
- **One Trash page** lists everything you can restore, from every workspace, with workspace, base
  and type filters, who deleted each item and how many days are left. The Trash links in a
  workspace and in a base open it filtered to them; the trash dialog inside a base is gone.
- **Members** shows each person's bases and role in one row, and pending invites can be changed
  in place. Faces are solid circles in each person's colour, with the leftmost face on top.
- `POST /api/workspaces/{id}/bases` accepts `empty: true` to create a base without tables;
  without it a base still starts with "Table 1".
- `intro_seen` on the signed-in user (`GET /api/auth/me`), set with `PATCH /api/auth/me`;
  everyone, including existing accounts after the upgrade, starts with `false`.
- **Workspace colours** from the same palette as bases. `color` on workspaces
  (`GET /api/workspaces`), accepted by `POST /api/workspaces` and `PATCH /api/workspaces/{id}`;
  a new workspace gets the first of green, blue, gray, purple, orange, teal, pink and yellow that
  none of your workspaces uses yet. `GET /api/bases/{id}` adds `workspace_color` and the invite
  preview `target_color`. Upgrading (database schema 6) colours existing workspaces in that order,
  oldest first, per person who created them.
- **One trash for everything.** `GET /api/trash` lists everything you could restore from every
  workspace you belong to, newest first, optionally filtered by `workspace_id`, `base_id` and
  `kind`; editors and viewers now find their own deleted personal views there (not through a
  read-only token, which cannot restore them). Trash items say
  where they were (`workspace_name`, `workspace_color`, `base_name`, `base_icon`, `base_color`,
  `table_name`), who deleted them (`deleted_by_id`, `deleted_by_name`) and when they are removed
  for good (`expires_at`); the existing trash listings carry the same fields. Who deleted
  something is recorded from this version on, so older items show no one.
- **Search everything.** `GET /api/search?q=` finds workspaces, bases, tables and views by name
  and records by the text of their primary field and their text, email, URL and phone fields,
  in everything you can open (`limit`, default 20, at most 50). Names come first, and text that
  starts with what you typed before text that contains it; a record found by another field
  carries a `snippet` of it. Record text is read up to a fixed budget per search (about one full
  table), so on very large instances some tables may not be searched.
- **Change a pending invite** without sending a new link: `PATCH /api/invites/{id}` takes `role`,
  `all_bases` and `base_ids` (each optional) and answers the updated invite. You need to be able
  to revoke the invite and to create one with the new terms (the same rules, including for
  base-limited API tokens); whoever changes it counts as its inviter from then on, so an invite
  changed by a creator never raises an existing member's role when accepted. Recorded in the audit
  log as `invite_update`. An invite that is no longer valid because of who made it (they were
  removed, demoted or lost a base) answers 409 like a used or expired one, and is left out of
  `GET /api/workspaces/{id}/invites` and `GET /api/bases/{id}/invites`. A creator changing only
  the role drops the trashed bases on the invite that they could not open.
- Each base in `GET /api/workspaces` lists its live `tables` (`id`, `name`, `icon`) in sidebar
  order, so the workspace page no longer loads every base to name its tables.

### Fixed

- Phones: tapping a text field no longer zooms the page in on iOS (form fields are 16px on touch
  screens and narrow windows), and the base's top bar no longer makes the page wider than a small
  phone. Buttons, menu items and the view list are larger on touch screens, the view options button
  is always visible there, and the expanded record scrolls as one column below tablet width.
- Phones: the icon picker opens as a bottom sheet that fits the visible screen and shrinks above the
  on-screen keyboard instead of running off the top, and the keyboard only opens when you tap the
  search box. A tap outside now closes it on iPhone, also when it was opened from the
  create/rename dialog, which stays open.

## [0.1.0] - 2026-10-13

First release. OpenBase is a self-hosted alternative to Airtable for individuals and very
small businesses, in one Rust binary with the web client embedded and a SQLite database.

### Added

- Accounts and administration: first-run setup (the first account is the administrator),
  invite-only or open sign-up, session management, password reset, passkey (WebAuthn)
  sign-in, TOTP two-factor authentication, profiles with time zones, personal access tokens,
  admin pages for users, outgoing email (SMTP), instance stats, the audit log and backups.
- Workspaces with five roles (owner, creator, editor, commenter, viewer), per-base sharing,
  invites by link or email, read-only view share links and public form links.
- Bases, tables and 28 field types, including linked records, formulas (Airtable-compatible
  syntax and function list), lookups, rollups, attachments with thumbnails and autonumber.
- Records: batch create, edit, delete and restore, comments with @mentions, per-record
  history, copy and paste, fill handle, undo and redo, search and a 30-day trash.
- Views: grid, form, gallery, kanban, calendar, timeline and list, each with nested filters,
  sorts, grouping, field layout, summaries and CSV export.
- Live collaboration over Server-Sent Events.
- Automations: record, form, schedule (cron) and webhook triggers; create-record,
  update-record, email, HTTP-request (with SSRF protection) and notification actions.
- An Airtable-compatible REST API under `/api/v1` and an MCP server at `/mcp` (about 70
  tools) with built-in OAuth 2.1 sign-in for AI assistants such as Claude and ChatGPT.
- CSV import and export.
- Operations: daily automatic backups with retention, `openbase backup` and `openbase restore`,
  an automatic database snapshot before every schema migration, a health endpoint
  (`/api/health`, which also reports the version) and `openbase healthcheck`.
- Deployment: a container image, a docker-compose stack with Caddy for automatic HTTPS, and a
  hardened systemd unit.

## [0.1.0-rc.2] - 2026-10-13

Second release candidate for OpenBase 0.1.0. It replaces 0.1.0-rc.1, whose release build
stopped at the end-to-end test gate and published nothing. It contains everything listed under
0.1.0 below. Not recommended for production use yet.

### Fixed

- Grid: right after "Add record", a delayed selection of the new row could move the selection
  under your next click, which then opened a cell editor or sent your typing to the button.

### Changed

- The release build now refuses to publish when any end-to-end test only passes on a retry.
- `scripts/release.sh` writes changelog links only to tags that exist and refuses to cut a
  release without notes under Unreleased.

## [0.1.0-rc.1] - 2026-10-13

### Added

- Release candidate for OpenBase 0.1.0, published to test the release pipeline end to end
  (native amd64 and arm64 builds, the `ghcr.io/lukewilson2002/openbase` image with provenance
  and SBOM attestations, and Linux binaries with checksums). It contains everything listed
  under 0.1.0 below. Not recommended for production use yet.

[Unreleased]: https://github.com/lukewilson2002/openbase/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/lukewilson2002/openbase/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/lukewilson2002/openbase/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/lukewilson2002/openbase/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/lukewilson2002/openbase/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/lukewilson2002/openbase/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/lukewilson2002/openbase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lukewilson2002/openbase/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lukewilson2002/openbase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.2...v0.1.0
[0.1.0-rc.2]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/lukewilson2002/openbase/releases/tag/v0.1.0-rc.1
