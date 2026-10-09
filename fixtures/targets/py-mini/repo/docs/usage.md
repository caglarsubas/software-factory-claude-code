# Using py-mini

## Stock

`Stock.add(sku, quantity)` and `Stock.remove(sku, quantity)` change stock levels.

## Tokens

`issue_token` and `verify_token` sign API tokens with an HMAC key the caller provides.

## Reports

`summary(stock)` summarises the stock.

## Snapshots

`save_snapshot` and `load_snapshot` write and read stock levels as JSON.
