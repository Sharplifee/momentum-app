# Momentum Landscaping — customer app

What a customer sees, and the API behind it. Split out of `Sharplifee/momentum`
on 2026-08-13, where it had lived inside the CRM's codebase — two products in
one repo meant two sessions deploying each other's half-finished work.

    momentumlandscapingut.com        the public site and quote form
    momentumlandscapingut.com/app    the customer app

    public/index.html      the marketing page
    public/app/index.html  the app itself, produced in Claude Design
    app/api/portal/*       17 endpoints the app calls
    app/api/weather        its own forecast

## It talks to the CRM through the database, not through code

Both read and write Supabase `izthjluendxpthmcndlv`. A job booked in the CRM
appears in the customer's schedule because they share tables, not because one
calls the other. Nothing here should ever fetch from
`crm.momentumlandscapingut.com` — that coupling is what the split removed.

The quote form posts to the CRM's `/api/leads` to create a lead. That is the one
deliberate outbound call, and it is one-way.

## Editing the app

`public/app/index.html` is a single ~945 KB file. Edit it here and commit — never
by downloading the live page and re-uploading it. That method silently reverted
work twice while the repos were shared.
