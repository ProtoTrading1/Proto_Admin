# Orders Workspace v1 Spec

Orders Workspace v1 is the first Apollo release after Infrastructure Freeze
v1.0. It is a product inside Apollo, not another infrastructure feature.

This specification is frozen for v1. Do not expand the scope until the customer
order notebook replacement works end to end.

## Mission

Replace Proto's customer-order notebook with a permanent, auditable workspace.

## Definition Of Success

A customer places an order. From that moment onwards, Apollo never forgets it.

Any member of the Proto team should be able to open an Order Workspace months
later and understand exactly what happened, what was promised, what decisions
were made, and what remains outstanding, without needing to ask the original
person.

## Primary Workflow

1. `/order Addie`
2. Customer identified
3. Order Workspace created
4. Excel uploaded
5. Apollo extracts products
6. Human confirms extracted lines
7. Tasks created
8. Due date assigned
9. Supplier assigned
10. Timeline begins
11. Reminders created
12. Order completed
13. Workspace archived

## Order Object

The Order object is one of Apollo's core Business Objects.

Required fields:

- `id`
- `status`
- `priority`
- `createdBy`
- `createdAt`
- `updatedAt`
- `customer`
- `products`
- `files`
- `tasks`
- `promises`
- `timeline`
- `reminders`

## Customer

The workspace must preserve customer context:

- Customer
- Account
- Contact
- Email
- Phone
- Notes

## Products

Each requested product line must track:

- SKU
- Description
- Requested quantity
- Confirmed quantity
- Status
- Supplier
- Price
- Availability

## Files

Files are drag-and-drop attachments. v1 supports simple storage and retrieval,
not complex document processing beyond Excel extraction.

File types:

- Excel
- Quotation
- Images
- Emails
- Invoices
- Packing list

## Tasks

Default task examples:

- Send quotation
- Order supplier
- Confirm stock
- Call customer
- Follow up
- Arrange delivery

Each task must track:

- Owner
- Due date
- Status
- Completed by
- Completed date

## Promises

Promises are first-class memory. Every promise made to a customer, supplier, or
team member must be recorded.

Examples:

- "We'll quote tomorrow."
- "We'll deliver Friday."
- "We'll confirm stock."
- "We'll phone after lunch."

Each promise must track:

- Promise text
- Made by
- Made to
- Due date
- Status
- Completed date
- Related task or timeline event

## Timeline

The timeline is automatically generated and append-only. Nobody edits timeline
history manually. Apollo writes it.

Example events:

- `09:32` Order created
- `09:35` Excel uploaded
- `09:37` Products confirmed
- `09:40` Quotation generated
- `11:02` Supplier assigned
- `Tomorrow` Reminder triggered
- `Friday` Customer emailed

Timeline events must preserve:

- Timestamp
- Actor
- Event type
- Human-readable summary
- Related object reference, when available

## Reminder Engine

Order reminders become Daily Brief items.

Reminder examples:

- Quotation due tomorrow
- Supplier not assigned
- Customer waiting
- Order inactive for 7 days
- Promise overdue

## Workspace Layout

v1 uses exactly three panels.

### Navigation

- Orders
- Customers
- Containers
- Buying
- Suppliers
- Memory

### Workspace

- Order
- Timeline
- Products
- Files
- Messages
- Tasks

### Current Context

- Customer
- Outstanding tasks
- Deadlines
- Recommendations
- Apollo Memory

## Commands

Initial commands:

- `/order Addie`
- `/order 500 wallets`
- `/order remind tomorrow`
- `/order supplier Motarro`
- `/order due Friday`
- `/order attach`
- `/order complete`

Commands may create drafts and suggestions. Human confirmation is required for
consequential actions.

## State Machine

Order status is explicit and never free-form.

1. Draft
2. Pending Review
3. Quoted
4. Waiting Supplier
5. Ordered
6. Waiting Arrival
7. Ready
8. Delivered
9. Closed

## Human Authority Rules

Apollo may:

- Create tasks
- Create reminders
- Suggest suppliers
- Extract Excel
- Suggest dates

Apollo may not, without confirmation:

- Email a customer
- Place a supplier order
- Approve a quotation

## Daily Brief Integration

Every morning Apollo checks:

- Orders overdue
- Promises overdue
- Supplier waiting
- Customer waiting
- Late quotation
- Inactive workspace
- Approaching deadline

## Search

Typing a customer or order term, for example `Addie`, should immediately show:

- Customer
- Open orders
- Last order
- Outstanding tasks
- Timeline
- Recommendations

## Acceptance Test

Someone phones Proto and orders products.

1. Type `/order Addie`.
2. Upload the Excel.
3. Approve the extracted lines.
4. Close Apollo.
5. Go on holiday.
6. Come back two weeks later.

Apollo must immediately tell you:

- What happened
- What has not happened
- Who is waiting
- What promises exist
- What still needs doing

If it can do that, the customer-order notebook is gone.

## Out Of Scope For v1

Do not add these until v1 succeeds:

- Automatic customer emails
- Automatic supplier orders
- Automatic quotation approval
- Complex kanban redesigns
- Multi-workspace orchestration
- New infrastructure or routing redesign
- New governance documents

