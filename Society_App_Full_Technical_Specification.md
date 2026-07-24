# Residential Society UPI Payment Tracker App
## Technical Specification & Architecture Blueprint

This document contains the complete system design, workflows, edge cases, and technology stack for building a 100% free-tier mobile application to track housing society UPI payments automatically.

---

## 1. System Vision & Core Workflow
The app eliminates manual data entry by allowing residents to pay maintenance via a dynamic UPI deep-link and seamlessly share the digital confirmation screen into the app. The backend leverages free cloud infrastructure and generative AI to read the receipt, extract metadata, avoid fraud, and generate automated receipts.

### Step-by-Step User Flow
1. **Profile Setup**: Resident downloads the application (via an APK link) and sets up a profile matching their **Name, Phone Number, and House/Flat Number**.
2. **Payment Trigger**: The user enters the maintenance amount and taps "Pay via UPI". 
3. **Deep Linking**: The app fires a native intent using a tailored UPI URL format:
   `upi://pay?pa=SOCIETY_VPA@bank&pn=SOCIETY_NAME&am=AMOUNT&tn=H_NUMBER`
4. **Payment Execution**: The device prompts the user to select their preferred installed UPI app (GPay, PhonePe, Paytm, BHIM). The payment is executed inside that secure banking sandbox.
5. **Data Handshake via Share Sheet**: Upon transaction completion, the user taps the standard native **"Share Receipt"** icon inside the UPI app and selects the **Society App** from their phone's share options.
6. **Background Ingestion**: The Society App captures the shared text or image asset and directly ships it to a server queue without holding up the user. The app tells the user: *"Proof uploaded! Processing in the background."*
7. **AI Extraction & Auto-Approval**: A server-side queue passes the asset to **Gemini 2.5 Flash** (Free Tier). Gemini parses the unstructured screenshot/text into a standardized JSON packet containing the exact 12-digit UTR, payment state, date, and amount.
8. **Verification & Ledger Logging**: The database verifies the transaction integrity, blocks duplicates, and auto-saves the confirmed record to a central ledger, simultaneously issuing a push notification receipt to the resident.

---

## 2. Recommended 100% Free Technology Stack

| Component | Technology Options | Why Selected (Free Tier Benefits) |
| :--- | :--- | :--- |
| **Mobile Frontend** | **Flutter** or **React Native** | Open-source, single codebase for cross-platform expansion. Easily compiles to standalone APKs. |
| **Share Sheet Integration** | `receive_sharing_intent` (Flutter) <br> `react-native-share-menu` (RN) | Free open-source plugins that make the app display natively inside the mobile system's "Share via..." window. |
| **Backend API Engine** | **Python (FastAPI / Flask)** or **Node.js (Express)** | Lightweight, highly extensible frameworks with native Google AI SDK support. |
| **Server Hosting** | **Render (Free Tier)** or <br> **Hugging Face Spaces** | Free cloud compute hosting for web apps and APIs. (Handles background scripts elegantly). |
| **Database & Auth** | **Supabase (Free Tier)** | Offers a completely free cloud Postgres database, built-in secure user authentication, and free storage buckets for receipt proof files. |
| **AI Extraction Engine** | **Google AI Studio (Gemini 2.5 Flash)** | **Permanently Free Tier**: Includes 15 requests per minute (RPM) and 1,000 requests per day (RPD). Superior to traditional OCR. |
| **Notifications** | **OneSignal (Free Tier)** or <br> **Firebase Cloud Messaging (FCM)** | Provides completely free push notifications to mobile devices for transaction confirmation updates. |

---

## 3. Database Schema Design (PostgreSQL / Supabase)

> **Superseded:** This initial sketch is retained for design history. The implementation baseline is the expanded multi-society schema and state model in Sections 7 and 8 below.

### Profiles Table (`profiles`)
Stores registered information about the residential estate members.
*   `id`: `UUID` (Primary Key, links to Auth)
*   `house_number`: `VARCHAR(20)` (Unique identification for sorting ledgers)
*   `owner_name`: `VARCHAR(100)`
*   `phone_number`: `VARCHAR(15)`
*   `created_at`: `TIMESTAMP` (Default: `NOW()`)

### Transactions Table (`transactions`)
Tracks ingestion, queue progression, and extraction parameters.
*   `id`: `UUID` (Primary Key)
*   `profile_id`: `UUID` (Foreign Key -> `profiles.id`)
*   `raw_shared_payload`: `TEXT` (Holds the original string text if shared directly)
*   `proof_file_url`: `TEXT` (Link to the screenshot image stored in Supabase Storage buckets)
*   `amount`: `NUMERIC(10, 2)` (Extracted by AI)
*   `utr_number`: `VARCHAR(12)` (**UNIQUE CONSTRAINT** - Crucial structural rule to block duplicate submissions)
*   `txn_date`: `DATE` (Extracted by AI)
*   `processing_status`: `ENUM` (`'Queued'`, `'Processing'`, `'Success'`, `'Manual_Review'`, `'Failed'`)
*   `remarks`: `TEXT`
*   `created_at`: `TIMESTAMP`

---

## 4. Advanced Edge Cases & Critical Design Fixes

### Edge Case 1: Dual-Transaction Upload Fraud (Double Spending)
*   **The Threat**: A resident attempts to reuse their payment proof from last month, or a malicious resident copies a valid transaction screenshot shared by a neighbor in a community group and submits it to claim credit for their own house.
*   **The Architectural Fix**: 
    1. Enforce a database level **Unique Constraint** on the `utr_number` field.
    2. When the backend extracts a UTR, the database automatically drops or rejects any row matching a sequence that already exists. 
    3. The application instantly triggers an automatic alert route flagging the account as `Potential Fraud Alert` for committee scrutiny.

### Edge Case 2: Free Server Inactivity Sleep (The "Cold Start" Problem)
*   **The Threat**: Free-tier cloud instances (like Render) spin down to save infrastructure resources if they experience 15 minutes of zero traffic. When the first resident of the morning loads the app, the container takes 30 to 50 seconds to initialize, causing network timeout exceptions or frozen user screens.
*   **The Architectural Fix**: Asynchronous UI Design. The mobile application front-end should perform a rapid upload of the text or image file directly to a cloud storage bucket, immediately log a local receipt state showing `"Proof Received & Processing"`, and let the resident exit the interface. A server-side webhook checks when the box spins up, parses it behind the scenes, and updates the profile via a non-blocking Push Notification.

### Edge Case 3: AI Output Hallucinations on Garbled/Low-Quality Content
*   **The Threat**: If a resident uploads a severely cropped, out-of-focus, compressed, or blurry transaction layout, a forced JSON prompt may cause Gemini to mistake characters or hallucinate numbers to fulfill the structure payload format.
*   **The Architectural Fix**: High-security prompting strategies. Instruct the Gemini model inside its system system prompt to continuously output a logical fallback verification parameters. 

**System Instruction Prompt Example:**
```text
You are a highly conservative financial data validation utility. Your target is to parse UPI confirmation logs.
Extract details into a tight JSON layout containing: amount, utr_number, and payment_status.
Strict Rule: If the 12-digit UTR numerical code is visually cropped, obfuscated, blurry, or missing even a single digit, you MUST fill the "utr_number" key as null, and add "manual_review": true inside the JSON response. Do not guess any missing integers.
```

### Edge Case 4: API Rate Limit Exhaustion During High-Volume Bill Cycles
*   **The Threat**: Maintenance bills are typically cleared simultaneously during peak cyclical windows (e.g., 1st to 5th of the month, during post-office hours from 7:00 PM to 10:00 PM). If 30 residents submit receipts in the same 60-second span, the backend hits Google AI Studio's limit of 15 Requests Per Minute (RPM) and returns a `429 Too Many Requests` crash state.
*   **The Architectural Fix**: Structural Task Queue. Do not call the Gemini API inside the main web request thread. When the app delivers data to your server, save the item to the database with a state indicator set to `'Queued'`. Run an asynchronous lightweight worker loop (Cron Job or background setInterval thread) that picks up one transaction every 5 seconds, processes it with Gemini, and moves to the next. This easily caps usage beneath the 15 RPM barrier while processing hundreds of records comfortably over peak hours.

### Edge Case 5: The "iPhone/iOS" Functional Variance
*   **The Threat**: Deep sharing frameworks operate uniquely across varying OS platforms. Android handles deep integrations fluidly via custom application targets; iOS sandboxing has stricter operational paradigms for third-party media file sharing.
*   **The Architectural Fix**: Implement a native fallback screen inside your mobile UI. If automated text/image retrieval returns zero parameters or fails entirely, expose a clean, single text input element titled **"Manual Verification Alternative"**. The system provides instructions: *"Copy the 12-digit Ref No from your payment screen, paste it here, and tap confirm."* This guarantees 100% operational availability regardless of individual user phone updates or ecosystem changes.

---

## 5. Resuming Work: Next Steps Blueprint
When you are ready to restart development with this or another AI assistant, use these prompts to execute parts of the implementation:

1. **For Database Setup**: *"Based on the attached Technical Specification doc, generate the SQL setup script to create the Supabase profiles, transactions table, and set up the Unique Constraint on the UTR column."*
2. **For Server Configuration**: *"Write a Python FastAPI script designed for Render that receives an incoming image or text shared payload, stores it in a queue, and feeds it to Gemini 2.5 Flash using the specified system validation prompt."*
3. **For Mobile App Development**: *"Provide a Flutter configuration example using `receive_sharing_intent` to set up the Android share sheet handler that pipes text directly into an API endpoint."*

---

## 6. Product Decisions

The following decisions are part of the product baseline and should guide implementation:

1. **Receipt extraction is not payment verification.** AI may read a receipt, but a screenshot alone cannot prove that money settled in the society bank account. Extracted submissions are therefore `Pending_Verification` until confirmed through bank reconciliation, a payment gateway webhook, a bank statement import, or an administrator review.
2. **The first release is an MVP.** The MVP supports approved resident accounts, current monthly charges, UPI payment initiation, receipt or UTR submission, AI-assisted extraction, administrator review, digital receipts, and ledger export.
3. **Residents cannot freely claim a flat.** A society administrator must create or approve the resident and flat association. Phone verification and an invite or flat activation code should be used during onboarding.
4. **The amount due is controlled by the society.** Residents see the server-provided charge. Any late fee, previous balance, discount, or adjustment must be represented explicitly rather than allowing an arbitrary payment amount.
5. **AI output is untrusted input.** The backend independently validates amount, UTR format, date, payment status, and billing-period rules. Low-confidence, incomplete, conflicting, duplicate, or amount-mismatched submissions go to manual review.
6. **The processing queue is database-backed.** Queue state must survive worker restarts and free-tier host sleep. Workers must support retries, locking, timeouts, and recorded errors.
7. **Payment verification will be strengthened after the MVP.** Automatic approval should be added only after a bank, gateway, or settlement reconciliation path is available.
8. **Financial proof is private data.** Receipt files use private storage and signed expiring URLs. Access is controlled with authentication, authorization policies, audit logs, file validation, and retention rules.
9. **The AI provider is replaceable.** AI extraction is isolated behind a service boundary so the provider or OCR implementation can change without changing the mobile or ledger workflows.

## 7. MVP Database Schema Design

The schema is multi-society from the beginning so that the data model does not need a breaking redesign when more than one housing society is onboarded. PostgreSQL types below are intended for Supabase migrations.

### Core Tables

#### Societies (`societies`)

Stores each housing society and its payment configuration.

* `id`: `UUID` (Primary Key)
* `name`: `VARCHAR(150)` (Required)
* `upi_vpa`: `VARCHAR(100)` (Required)
* `upi_payee_name`: `VARCHAR(150)` (Required)
* `timezone`: `VARCHAR(50)` (Default: `Asia/Kolkata`)
* `status`: `VARCHAR(20)` (`'Active'` or `'Inactive'`)
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)
* `updated_at`: `TIMESTAMPTZ` (Default: `NOW()`)

#### Society Members (`society_members`)

Associates authenticated users with a society and role. The resident's flat association is approved by an administrator rather than being trusted from registration input.

* `id`: `UUID` (Primary Key)
* `society_id`: `UUID` (Foreign Key -> `societies.id`)
* `auth_user_id`: `UUID` (Foreign Key -> `auth.users.id`)
* `role`: `VARCHAR(20)` (`'Resident'`, `'Admin'`, or `'Committee'`)
* `status`: `VARCHAR(20)` (`'Invited'`, `'Active'`, or `'Suspended'`)
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)
* `updated_at`: `TIMESTAMPTZ` (Default: `NOW()`)

Constraint: `UNIQUE (society_id, auth_user_id)`.

#### Flats (`flats`)

Stores the homes that can be billed.

* `id`: `UUID` (Primary Key)
* `society_id`: `UUID` (Foreign Key -> `societies.id`)
* `flat_number`: `VARCHAR(20)` (Required)
* `owner_name`: `VARCHAR(100)`
* `status`: `VARCHAR(20)` (`'Active'` or `'Inactive'`)
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)
* `updated_at`: `TIMESTAMPTZ` (Default: `NOW()`)

Constraint: `UNIQUE (society_id, flat_number)`.

#### Resident Flat Assignments (`resident_flat_assignments`)

Links a resident to an approved flat and preserves assignment history.

* `id`: `UUID` (Primary Key)
* `society_member_id`: `UUID` (Foreign Key -> `society_members.id`)
* `flat_id`: `UUID` (Foreign Key -> `flats.id`)
* `status`: `VARCHAR(20)` (`'Pending'`, `'Active'`, or `'Revoked'`)
* `approved_by`: `UUID` (Foreign Key -> `auth.users.id`)
* `approved_at`: `TIMESTAMPTZ`
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)

Only one active assignment should exist for a resident and flat at a time.

#### Billing Periods (`billing_periods`)

Defines the charge for a flat for a specific month.

* `id`: `UUID` (Primary Key)
* `society_id`: `UUID` (Foreign Key -> `societies.id`)
* `flat_id`: `UUID` (Foreign Key -> `flats.id`)
* `period_month`: `DATE` (First day of the billing month)
* `base_amount`: `NUMERIC(10, 2)` (Required)
* `late_fee`: `NUMERIC(10, 2)` (Default: `0`)
* `previous_balance`: `NUMERIC(10, 2)` (Default: `0`)
* `adjustment`: `NUMERIC(10, 2)` (Default: `0`)
* `amount_due`: `NUMERIC(10, 2)` (Required)
* `status`: `VARCHAR(20)` (`'Open'`, `'Closed'`, or `'Waived'`)
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)
* `updated_at`: `TIMESTAMPTZ` (Default: `NOW()`)

Constraint: `UNIQUE (flat_id, period_month)`. The amount due is calculated and stored by trusted backend or administrator logic.

#### Transactions (`transactions`)

Stores payment submissions, extraction results, verification, and ledger state.

* `id`: `UUID` (Primary Key)
* `society_id`: `UUID` (Foreign Key -> `societies.id`)
* `flat_id`: `UUID` (Foreign Key -> `flats.id`)
* `billing_period_id`: `UUID` (Foreign Key -> `billing_periods.id`)
* `submitted_by`: `UUID` (Foreign Key -> `auth.users.id`)
* `raw_shared_payload`: `TEXT`
* `proof_file_path`: `TEXT` (Private storage path, not a public URL)
* `amount`: `NUMERIC(10, 2)`
* `utr_number`: `VARCHAR(32)`
* `txn_date`: `TIMESTAMPTZ`
* `payment_status`: `VARCHAR(30)` (`'Success'`, `'Failed'`, or `'Pending'`)
* `extraction_confidence`: `NUMERIC(5, 4)`
* `processing_status`: `VARCHAR(30)` (See state model below)
* `attempt_count`: `INTEGER` (Default: `0`)
* `next_attempt_at`: `TIMESTAMPTZ`
* `locked_until`: `TIMESTAMPTZ`
* `last_error`: `TEXT`
* `manual_review_reason`: `TEXT`
* `verified_by`: `UUID` (Foreign Key -> `auth.users.id`)
* `verified_at`: `TIMESTAMPTZ`
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)
* `updated_at`: `TIMESTAMPTZ` (Default: `NOW()`)

Recommended constraints and indexes:

* `UNIQUE (society_id, utr_number)` for non-null UTR values, preventing the same payment from being credited twice in one society.
* Check that monetary values are greater than or equal to zero.
* Check that `extraction_confidence` is between `0` and `1`.
* Index `(processing_status, next_attempt_at)` for queue workers.
* Index `(society_id, flat_id, billing_period_id)` for ledger queries.

#### Audit Events (`audit_events`)

Records sensitive administrative and verification actions.

* `id`: `UUID` (Primary Key)
* `society_id`: `UUID` (Foreign Key -> `societies.id`)
* `actor_user_id`: `UUID` (Foreign Key -> `auth.users.id`)
* `entity_type`: `VARCHAR(50)`
* `entity_id`: `UUID`
* `action`: `VARCHAR(50)`
* `metadata`: `JSONB`
* `created_at`: `TIMESTAMPTZ` (Default: `NOW()`)

### Security and Data Rules

* Enable Supabase Row Level Security on all application tables.
* Residents can read only their society, approved flat assignment, billing periods, and their own transactions.
* Residents can create a submission only for an approved flat assignment and an open billing period.
* Only administrators or committee members can approve, reject, waive, or export ledger records.
* Proof files remain in a private storage bucket and are accessed through short-lived signed URLs.
* Retention and deletion policy must be defined before production launch; audit events should not be silently deleted when a proof file is removed.

## 8. Transaction State Transition Model

`processing_status` describes the lifecycle of a payment submission. Receipt extraction and financial verification are separate stages.

### States

| State | Meaning |
| :--- | :--- |
| `Submitted` | Submission and proof file were accepted and stored. |
| `Queued` | Waiting for the extraction worker. |
| `Processing` | A worker has locked the record and is calling the extraction service. |
| `Extracted` | Required fields were parsed and passed basic format validation. |
| `Pending_Verification` | Extraction succeeded, but payment settlement still needs bank, gateway, or admin confirmation. |
| `Manual_Review` | Information is incomplete, conflicting, duplicated, low-confidence, or otherwise requires a person. |
| `Verified` | Payment was confirmed and credited to the billing period. |
| `Rejected` | Submission was reviewed and not accepted. |
| `Failed` | Technical processing failed after retry handling or the proof could not be processed. |

### Allowed Transitions

| From | To | Trigger |
| :--- | :--- | :--- |
| `Submitted` | `Queued` | Storage succeeds and the transaction is enqueued. |
| `Queued` | `Processing` | Worker claims an unlocked record. |
| `Processing` | `Extracted` | AI/OCR returns valid required fields. |
| `Processing` | `Manual_Review` | Missing UTR, low confidence, unreadable proof, mismatch, or duplicate detected. |
| `Processing` | `Queued` | Retryable provider, network, or rate-limit error. |
| `Processing` | `Failed` | Non-retryable processing error or retry limit reached. |
| `Extracted` | `Pending_Verification` | Basic validation passes, but settlement is not confirmed. |
| `Pending_Verification` | `Verified` | Bank/gateway reconciliation or authorized admin confirmation succeeds. |
| `Pending_Verification` | `Manual_Review` | Reconciliation conflict or amount/date discrepancy is found. |
| `Manual_Review` | `Verified` | Authorized reviewer confirms the payment. |
| `Manual_Review` | `Rejected` | Authorized reviewer rejects the submission. |
| `Failed` | `Queued` | Authorized retry or automated retry policy reopens processing. |
| `Rejected` | `Manual_Review` | Authorized reviewer reopens the record with a reason. |

### Transition Rules

1. Every transition must update `updated_at` and create an `audit_events` record for administrator-visible actions.
2. A worker must set `locked_until` when entering `Processing`. Expired locks make the record eligible for retry.
3. A retry must increment `attempt_count`, store `last_error`, and calculate `next_attempt_at` with bounded backoff.
4. Only `Verified` transactions count toward the resident ledger balance and digital receipt.
5. A transaction cannot enter `Verified` if its UTR is already credited to another transaction in the same society.
6. A rejected or failed record is never deleted as part of normal workflow; it remains available for audit and support.

---

## 9. Implementation Order

1. Create the Supabase migration for the tables, enums or check constraints, indexes, and initial Row Level Security policies.
2. Seed one test society, flats, administrator, resident, and open billing period.
3. Implement authenticated resident and administrator API access.
4. Implement transaction submission and database-backed queue claiming.
5. Add extraction with strict schema validation and manual-review routing.
6. Build the administrator ledger, approval workflow, and audit history.
7. Add UPI initiation, receipt sharing, notifications, and exports.
8. Add bank or payment gateway reconciliation before enabling automatic verification.