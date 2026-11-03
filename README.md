# AutoPay — i20 Active installment tracker

A small, dependency-free payment tracker for the i20 Active sale.

## Current plan

- Agreed sale price: ₹2,75,000
- Down payment received: ₹75,000
- Monthly installment: ₹15,000
- Balance after down payment: ₹2,00,000 (13 installments of ₹15,000 and a final ₹5,000 installment)

The first installment date can be changed in **Edit plan**. Use **Record payment** when an installment arrives. You can undo an entry from the payment history.

## Run locally

Open `index.html` in a browser. The plan and payment history are saved in that browser's local storage.

## Sharing

Use **Share snapshot** to copy a link containing the current plan and payment history. Anyone with that link can view that snapshot. Later edits do not change links already sent; share a new snapshot link after recording more payments. This static site does not sync edits between browsers.

## Publish with GitHub Pages

Create a GitHub repository, push these files to its `main` branch, then enable **Settings → Pages → Deploy from a branch → main / (root)**. The site will be available at `https://<your-user>.github.io/<repository>/`.
