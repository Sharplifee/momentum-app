# One version, everywhere, always

The thing that confused this for weeks: it looks like there are two build
systems. There are not. There is one product with two delivery speeds, and
knowing which is which tells you what happens when you change something.

## What is actually shipped

Both iOS apps are shells around a website. There are no native screens in
either. Everything a person sees — every button, every screen, every fix — is
web, served from Vercel.

    crm.momentumlandscapingut.com     the CRM, admin and crew sides
    momentumlandscapingut.com         the public site and quote form
    momentumlandscapingut.com/app     the customer app

The shells add only what a browser cannot do: background location for the crew,
push notifications, and an icon on the home screen.

## So a change reaches everyone instantly

Change the web, deploy, done. Every phone shows it on next open — no App Store
review, no version to force, no user left behind on something old. This is true
before launch and stays true after.

There is no such thing as a stale copy, because there is no copy. The phone is
looking at the same page you are.

## The shell almost never changes

Only when permissions, background behaviour, the icon or the bundle change.
Perhaps a few times a year. That is the path that needs Apple review, and it is
deliberately rare.

## One repo per product. No exceptions.

    Sharplifee/momentum        the CRM website. Crew phones point at it.
    Sharplifee/momentum-app    the customer app: screens, API, and shell/
    Sharplifee/momentum-crew   the crew app shell
    Sharplifee/momentum-crm    ARCHIVED. Never deploy from it.

Two rules learned the hard way:

**A repo that cannot build must not carry a build workflow.** The CRM repo had
an iOS workflow and no iOS project, so it could only ever fail — a button that
invites you to press it and then wonders why nothing shipped.

**An app's shell lives with its own code.** The customer app was split across
two repos, which is how you end up unsure which one is real.

## Nothing lives only on a laptop

The crew app existed as a folder on one MacBook. It could not be changed or
shipped without that machine, and the copy installed on the phone did not match
anything in version control. Both apps build on GitHub runners now, from any
device, using the same Apple account and signing certificate.

If a phone shows something no repo contains, it was sideloaded from a laptop.
Rebuild from the repo and install over it.
