#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol};

const OPERATOR: Symbol = symbol_short!("operator");
const PLATFORM: Symbol = symbol_short!("platform");
const TOKEN: Symbol = symbol_short!("token");
const INIT: Symbol = symbol_short!("init");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    CampaignNotFound = 5,
    SponsorMismatch = 6,
    InsufficientPool = 7,
    CampaignExists = 8,
}

#[derive(Clone)]
#[contracttype]
pub struct Campaign {
    pub sponsor: Address,
    pub pool_balance: i128,
    pub payout_per_milestone: i128,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Campaign(u32),
}

#[contract]
pub struct CampaignEscrow;

fn token_client<'a>(e: &Env) -> token::Client<'a> {
    let t: Address = e.storage().instance().get(&TOKEN).unwrap();
    token::Client::new(e, &t)
}

#[contractimpl]
impl CampaignEscrow {
    /// Chame uma única vez após o deploy. `operator` assina `payout`.
    pub fn initialize(e: Env, operator: Address, platform: Address, token: Address) -> Result<(), Error> {
        if e.storage().instance().get::<Symbol, bool>(&INIT).unwrap_or(false) {
            return Err(Error::AlreadyInitialized);
        }
        e.storage().instance().set(&INIT, &true);
        e.storage().instance().set(&OPERATOR, &operator);
        e.storage().instance().set(&PLATFORM, &platform);
        e.storage().instance().set(&TOKEN, &token);
        Ok(())
    }

    pub fn create_campaign(
        e: Env,
        sponsor: Address,
        campaign_id: u32,
        payout_per_milestone: i128,
    ) -> Result<(), Error> {
        sponsor.require_auth();
        if !e.storage().instance().get::<Symbol, bool>(&INIT).unwrap_or(false) {
            return Err(Error::NotInitialized);
        }
        if payout_per_milestone <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Campaign(campaign_id);
        if e.storage().persistent().has(&key) {
            return Err(Error::CampaignExists);
        }
        e.storage().persistent().set(
            &key,
            &Campaign {
                sponsor,
                pool_balance: 0,
                payout_per_milestone,
            },
        );
        Ok(())
    }

    /// Patrocinador aprova o contrato como `spender` no token SEP-41 por `amount` antes de chamar.
    /// Repasse: 20% → plataforma, 80% → pool do contrato.
    pub fn fund(e: Env, sponsor: Address, campaign_id: u32, amount: i128) -> Result<(), Error> {
        sponsor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Campaign(campaign_id);
        let mut c: Campaign = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CampaignNotFound)?;
        if c.sponsor != sponsor {
            return Err(Error::SponsorMismatch);
        }

        let fee = amount
            .checked_mul(20)
            .and_then(|v| v.checked_div(100))
            .ok_or(Error::InvalidAmount)?;
        let to_pool = amount.checked_sub(fee).ok_or(Error::InvalidAmount)?;

        let contract_addr = e.current_contract_address();
        let platform: Address = e.storage().instance().get(&PLATFORM).unwrap();
        let client = token_client(&e);

        if fee > 0 {
            client.transfer_from(&contract_addr, &sponsor, &platform, &fee);
        }
        if to_pool > 0 {
            client.transfer_from(&contract_addr, &sponsor, &contract_addr, &to_pool);
        }

        c.pool_balance = c
            .pool_balance
            .checked_add(to_pool)
            .ok_or(Error::InvalidAmount)?;
        e.storage().persistent().set(&key, &c);
        Ok(())
    }

    /// Operador paga um criador a partir do pool da campanha.
    pub fn payout(
        e: Env,
        operator: Address,
        campaign_id: u32,
        creator: Address,
        amount: i128,
    ) -> Result<(), Error> {
        operator.require_auth();
        let expected: Address = e.storage().instance().get(&OPERATOR).unwrap();
        if operator != expected {
            return Err(Error::Unauthorized);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Campaign(campaign_id);
        let mut c: Campaign = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CampaignNotFound)?;
        if c.pool_balance < amount {
            return Err(Error::InsufficientPool);
        }

        let contract_addr = e.current_contract_address();
        let client = token_client(&e);
        client.transfer(&contract_addr, &creator, &amount);

        c.pool_balance = c.pool_balance.checked_sub(amount).ok_or(Error::InvalidAmount)?;
        e.storage().persistent().set(&key, &c);
        Ok(())
    }

    pub fn get_campaign(e: Env, campaign_id: u32) -> Result<Campaign, Error> {
        let key = DataKey::Campaign(campaign_id);
        e.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CampaignNotFound)
    }
}
