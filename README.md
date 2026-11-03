# AutoPay — i20 Active installment tracker

A small, dependency-free payment tracker for the i20 Active sale.

## Current plan

- Agreed sale price: ₹2,75,000
- Down payment received: ₹70,000 on 10 Aug 2026
- Monthly installment: ₹15,000
- Balance after down payment: ₹2,05,000
- Payments recorded: ₹15,000 on 3 Sep 2026 and ₹15,000 on 2 Nov 2026
- Current balance: ₹1,75,000 (12 installments left: 11 of ₹15,000 and a final ₹10,000 installment)

The down payment date and first installment date are both shown in the tracker. They can be changed in **Edit plan**. Use **Record payment** when an installment arrives. You can undo an entry from the payment history.

## Run locally

Open `index.html` in a browser. The plan and payment history are saved in that browser's local storage.

## Sharing

Use **Share snapshot** to copy a link containing the current plan and payment history. Anyone with that link can view that snapshot. Later edits do not change links already sent; share a new snapshot link after recording more payments. This static site does not sync edits between browsers.

## Publish with GitHub Pages

Create a GitHub repository, push these files to its `main` branch, then enable **Settings → Pages → Deploy from a branch → main / (root)**. The site will be available at `https://<your-user>.github.io/<repository>/`.
