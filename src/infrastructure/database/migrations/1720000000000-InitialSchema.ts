import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1720000000000 implements MigrationInterface {
  name = "InitialSchema1720000000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id varchar(160) NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallet_id_player_currency UNIQUE (id, player_id, currency)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(160),
        external_transaction_id varchar(200),
        idempotency_key varchar(200),
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id varchar(160) NOT NULL,
        round_id varchar(200) NOT NULL,
        game_id varchar(200) NOT NULL,
        type varchar(16) NOT NULL CHECK (type IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        status varchar(24) NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(200),
        ref_attempts integer NOT NULL DEFAULT 0 CHECK (ref_attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        failure_code varchar(80),
        result_balance numeric(20,2) CHECK (result_balance IS NULL OR result_balance >= 0),
        CONSTRAINT fk_wager_wallet_player_currency FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets(id, player_id, currency)
      );
      CREATE UNIQUE INDEX uq_wager_provider_external
        ON wager_transactions(provider_id, external_transaction_id)
        WHERE provider_id IS NOT NULL AND external_transaction_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_wager_wallet_idempotency
        ON wager_transactions(wallet_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX uq_wager_reference_reversal
        ON wager_transactions(provider_id, reference_external_transaction_id, type)
        WHERE type IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL
          AND status IN ('PENDING','PENDING_REFERENCE','PROCESSED');
      CREATE INDEX ix_wager_wallet_created ON wager_transactions(wallet_id, created_at DESC, id DESC);
      CREATE INDEX ix_wager_reference_due ON wager_transactions(next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions(id),
        direction varchar(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_ledger_balance_step CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
      CREATE INDEX ix_ledger_wallet_created ON wallet_ledger_entries(wallet_id, created_at DESC, id DESC);

      CREATE TABLE message_inbox (
        consumer_name varchar(120) NOT NULL,
        message_id varchar(200) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer_name, message_id)
      );
      CREATE TABLE message_outbox (
        id uuid PRIMARY KEY,
        queue_name varchar(16) NOT NULL CHECK (queue_name IN ('requests','events')),
        event_type varchar(80) NOT NULL,
        aggregate_id uuid NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      );
      CREATE INDEX ix_outbox_publish_due ON message_outbox(next_attempt_at, created_at)
        WHERE published_at IS NULL;

      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

      CREATE FUNCTION check_wallet_ledger_consistency() RETURNS trigger AS $$
      DECLARE
        wid uuid;
        wallet_balance numeric(20,2);
        wallet_version integer;
        ledger_balance numeric(20,2);
        ledger_count bigint;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id;
        ELSE wid := NEW.wallet_id;
        END IF;
        SELECT balance, version INTO wallet_balance, wallet_version FROM wallets WHERE id = wid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0),
               COUNT(*) INTO ledger_balance, ledger_count
          FROM wallet_ledger_entries WHERE wallet_id = wid;
        IF wallet_balance <> ledger_balance OR wallet_version <> ledger_count + 1 THEN
          RAISE EXCEPTION 'wallet % balance/version differs from append-only ledger', wid;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER trg_wallet_ledger_consistency_wallet
        AFTER UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_consistency();
      CREATE CONSTRAINT TRIGGER trg_wallet_ledger_consistency_entry
        AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_consistency();

      CREATE FUNCTION prevent_terminal_wager_change() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'terminal wager transactions are immutable';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.type, NEW.amount,
            NEW.currency, NEW.reference_external_transaction_id)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.type, OLD.amount,
            OLD.currency, OLD.reference_external_transaction_id) THEN
          RAISE EXCEPTION 'wager identity and financial fields are immutable';
        END IF;
        IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'invalid wager transition % -> %', OLD.status, NEW.status;
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status NOT IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'invalid wager transition % -> %', OLD.status, NEW.status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_wager_transition
        BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION prevent_terminal_wager_change();

      CREATE FUNCTION check_processed_wager_ledger() RETURNS trigger AS $$
      DECLARE
        ledger_count bigint;
        current_status varchar(24);
        current_type varchar(16);
        current_wallet uuid;
        current_amount numeric(20,2);
        current_currency char(3);
      BEGIN
        SELECT status,type,wallet_id,amount,currency
          INTO current_status,current_type,current_wallet,current_amount,current_currency
          FROM wager_transactions WHERE id=NEW.id;
        SELECT COUNT(*) INTO ledger_count FROM wallet_ledger_entries WHERE transaction_id = NEW.id;
        IF current_status = 'PROCESSED' AND current_type <> 'LOSS' AND ledger_count <> 1 THEN
          RAISE EXCEPTION 'processed balance-affecting transaction % must have one ledger entry', NEW.id;
        END IF;
        IF (current_status <> 'PROCESSED' OR current_type = 'LOSS') AND ledger_count <> 0 THEN
          RAISE EXCEPTION 'non-financial transaction % cannot have a ledger entry', NEW.id;
        END IF;
        IF ledger_count = 1 AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries l
          WHERE l.transaction_id = NEW.id AND l.wallet_id = current_wallet
            AND l.amount = current_amount AND l.currency = current_currency
        ) THEN
          RAISE EXCEPTION 'ledger does not match wager transaction %', NEW.id;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER trg_wager_ledger_consistency
        AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_processed_wager_ledger();
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE IF EXISTS message_outbox;
      DROP TABLE IF EXISTS message_inbox;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
      DROP FUNCTION IF EXISTS check_processed_wager_ledger();
      DROP FUNCTION IF EXISTS prevent_terminal_wager_change();
      DROP FUNCTION IF EXISTS check_wallet_ledger_consistency();
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
    `);
  }
}
