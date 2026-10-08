# AutoPrompter Server

Control AutoPrompter Server from Companion over OSC: transport, setlist, songs and speeches,
markers, overlays, ready light, timers and instant messages — with feedback, so your buttons
reflect what is actually on screen.

## Setting up

**In AutoPrompter Server**, open the admin panel and find the OSC section:

1. Check the **RX port** — the port AutoPrompter listens on, `9000` by default.
2. Set **TX IP** and **TX port** to the machine running Companion and the port Companion listens
   on (`9001` by default). Without this, commands still work but no feedback comes back.
3. Press **Start OSC**: the indicator turns green.

The **Commands** button in the same panel opens the full OSC reference, useful if you also want to
send messages from something other than Companion.

**In Companion**, add the connection and fill in:

| Field | Meaning |
|---|---|
| AutoPrompter Server IP | Address of the machine running AutoPrompter |
| TX Port | The port AutoPrompter listens on — must match its RX port (`9000`) |
| RX Port | The port this module listens on for feedback — must match AutoPrompter's TX port (`9001`) |

Both machines must be on the same network, with those UDP ports open.

## What you can control

**Transport** — play, stop, toggle, rewind to start.

**Speed** — step up and down, or set an exact value (25–120).

**Text size** — the prompter works in *visible lines*, not point size: fewer lines means bigger
text. Step up and down, or set an exact value (3–15).

**Setlist, songs and speeches** — the quickest way to drive a show is **Setlist — Go to row**: give
it a row number and AutoPrompter works out what is there. If the row holds a song it loads it; if it
holds a speech it opens it full screen and announces the next song. The numbers are the same ones
shown in the AutoPrompter remote, so ten buttons numbered 1 to 10 are usually all you need.

There are also **Next row** and **Previous row**, loading a song or a speech **by name**, closing a
speech, and clearing the text back to the logo.

When you load a song by name you pick it from a **drop-down list** of the songs in the show's text
folder, kept up to date by AutoPrompter. You can still type a name by hand.

**Markers** — next, previous, go to a marker by index or by name. Going **by name** offers a
drop-down list of the markers in the text currently open: open the song in the prompter first, then
pick its markers. A marker is found by name wherever it sits, so the button keeps working if the
text is edited and markers move; if two markers share a name, the first one wins. The marker lands
just above the pointer. Marker labels also arrive as variables, so a button can show the name of the
marker it jumps to.

**Overlays and ready light** — blackout, test pattern, logo; ready light green, red or off.

**Notes and instant messages** — show a note over the text, or send a message to the operator.

**Stopwatch, clock and countdown** — show and hide, start and pause, reset, set a duration, add or
subtract seconds, count up or down.

## Feedback

Button styles can follow the real state of the prompter: playing or stopped, blackout, test pattern,
logo, ready light colour, screens connected, stopwatch running, countdown direction, instant message
on screen, and whether a speech is open.

Two feedbacks are particularly handy for the setlist:

- **Current song is…** — matches by name
- **Current song is setlist row…** — matches by row number

so the button of the song on air lights up by itself. **Current marker is…** does the same for
markers: the button lights up while the text is on that marker. Songs and markers work together, so
a page can hold the songs of the show and, beside them, the markers of each one.

There is feedback for the ShuttleXpress too: whether it is connected, whether cruise is engaged and
whether it is paused.

## Presets

Ready-made buttons for every group of actions. A few are templates to finish after dragging them onto
a page:

- **Song → Load song** — pick the song in the action *and* in the feedback, so the button both loads
  it and lights up while it is on air. **Clear song** goes back to the logo.
- **Marker → Go to marker by name** — pick the marker in the action and in the feedback, the same way.
- **Instant message → custom** — write your own text in the action.

## Variables

Prefix is `$(autoprompter-server:…)`.

| Variable | Contents |
|---|---|
| `playing`, `blackout`, `testpattern`, `logo` | Transport and overlays (0/1) |
| `semaforo` | Ready light: `none`, `ok` or `ko` |
| `viewers` | Screens connected |
| `fontsize` | Visible lines |
| `font_family` | Font in use |
| `song_current` | Current song |
| `song_index` | Its setlist row (0 = not in the setlist) |
| `setlist_name`, `setlist_count` | Setlist in use and how many rows it has |
| `portal_open` | A speech is open (0/1) |
| `marker_count`, `marker_current` | Marker count, and which one the text is on |
| `marker_0` … `marker_N` | Marker labels, created as the document is loaded |
| `timer_vis`, `timer_running`, `timer_value` | Stopwatch |
| `clock_vis` | Clock |
| `countdown_vis`, `countdown_value`, `countdown_setting`, `countdown_mode` | Countdown |
| `imsg_active` | Instant message on screen (0/1) |
| `shuttle_connected`, `cruise_active`, `cruise_paused` | ShuttleXpress |
| `pointer_hidden`, `daylight` | Appearance |

## Requirements

AutoPrompter Server **2.2.9 or later** for the song list and for the full state when Companion
connects. With older versions everything else works, but the drop-down lists stay empty (names can
still be typed) and buttons only update once something changes on the prompter.

## If feedback does not arrive

Commands travel one way and feedback the other, so check the return path: AutoPrompter's **TX IP**
must point at the Companion machine, and its **TX port** must match this module's **RX port**.

In AutoPrompter the **Monitor** button logs every OSC message it receives, which is the quickest way
to tell whether your commands are arriving at all.
