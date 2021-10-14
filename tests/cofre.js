const anchor = require("@project-serum/anchor");
const { TOKEN_PROGRAM_ID, Token } = require("@solana/spl-token");
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js")
const assert = require("assert");

// TODO Move tests to typescript!

describe("cofre", () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cofre;

  let mintA = null;
  let mintB = null;
  let makerTokenAccountA = null;
  let makerTokenAccountB = null;
  let takerTokenAccountA = null;
  let takerTokenAccountB = null;

  const makerAmount = 1;
  const takerAmount = 2;

  const escrowState        = Keypair.generate();
  const maker              = Keypair.generate();
  const taker              = Keypair.generate();
  const mintAuthority      = Keypair.generate();

  let escrowVault = null;
  let vaultBump = null;

  it("Initialize Mints and Accounts", async () => {
    // Airdropping tokens to a maker.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(maker.publicKey, 1000000000000),
      "confirmed"
    );

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(taker.publicKey, 1000000000000),
      "confirmed"
    );

    mintA = await Token.createMint(
      provider.connection,
      maker,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    mintB = await Token.createMint(
      provider.connection,
      maker,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    // TODO QUESTION Who is paying for these createAccount
    // Seems like the provider
    // Can we set it to be payed by the owner
    makerTokenAccountA = await mintA.createAssociatedTokenAccount(maker.publicKey);
    takerTokenAccountA = await mintA.createAssociatedTokenAccount(taker.publicKey);

    makerTokenAccountB = await mintB.createAssociatedTokenAccount(maker.publicKey);
    takerTokenAccountB = await mintB.createAssociatedTokenAccount(taker.publicKey);

    await mintA.mintTo(
      makerTokenAccountA,
      mintAuthority.publicKey, // TODO Pass signer instead of pubkey+[signer]
      [mintAuthority],
      makerAmount
    );

    await mintB.mintTo(
      takerTokenAccountB,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    // Get the PDA that is assigned authority to token account.
    const [_pda, _bump] = await PublicKey.findProgramAddress(
      [escrowState.publicKey.toBuffer()],
      program.programId
    );

    escrowVault = _pda;
    vaultBump = _bump;

    let _makerTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);
    let _takerTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);
    let _makerTokenAccountB = await mintB.getAccountInfo(makerTokenAccountB);
    let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);
    assert.ok(_makerTokenAccountA.owner.equals(maker.publicKey))
    assert.ok(_makerTokenAccountB.owner.equals(maker.publicKey))
    assert.ok(_takerTokenAccountA.owner.equals(taker.publicKey))
    assert.ok(_takerTokenAccountB.owner.equals(taker.publicKey))

    assert.equal(_makerTokenAccountA.amount.toNumber(), makerAmount);
    assert.equal(_takerTokenAccountA.amount.toNumber(), 0);
    assert.equal(_makerTokenAccountB.amount.toNumber(), 0);
    assert.equal(_takerTokenAccountB.amount.toNumber(), takerAmount);
  });

  describe("SplSpl trade", () => {
    it("Initialize", async () => {
      await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(makerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenAccountA,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let _makerTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);
      let _escrowVault = await mintA.getAccountInfo(escrowVault);

      let _escrowState = await program.account.escrowState.fetch(escrowState.publicKey);

      // Check that the owner of the maker account is still the maker
      assert.ok(_makerTokenAccountA.owner.equals(maker.publicKey));

      // Check that the owner of the vault is the PDA.
      assert.ok(_escrowVault.owner.equals(escrowVault));
      assert.equal(_escrowVault.amount.toNumber(), makerAmount);
      assert.ok(_escrowVault.mint.equals(mintA.publicKey));

      // Check that the values in the escrow account match what we expect.
      assert.ok(_escrowState.maker.equals(maker.publicKey));
      assert.equal(_escrowState.makerAmount.toNumber(), makerAmount);
      assert.equal(_escrowState.takerAmount.toNumber(), takerAmount);
      assert.ok(_escrowState.trade.splSpl.fromToken.equals(makerTokenAccountA));
      assert.ok(_escrowState.trade.splSpl.fromMint.equals(mintA.publicKey));
      assert.ok(_escrowState.trade.splSpl.toToken.equals(makerTokenAccountB));
      assert.ok(_escrowState.trade.splSpl.toMint.equals(mintB.publicKey));
      assert.ok(_escrowState.vault.equals(escrowVault))
    });

    it("Invalid Exchange", async () => {
      let mintC = await Token.createMint(
        provider.connection,
        maker,
        mintAuthority.publicKey,
        null,
        0,
        TOKEN_PROGRAM_ID
      );

      let takerTokenAccountC = await mintC.createAccount(taker.publicKey);

      await mintC.mintTo(
        takerTokenAccountC,
        mintAuthority.publicKey,
        [mintAuthority],
        takerAmount
      );

      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        async () => {
          await program.rpc.exchange(new anchor.BN(vaultBump), {
            accounts: {
              taker: taker.publicKey,
              fromTakerAccount: takerTokenAccountC,
              toTakerAccount: takerTokenAccountA,
              maker: maker.publicKey,
              toMakerAccount: makerTokenAccountB,
              escrowVault: escrowVault,
              escrowState: escrowState.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId
            },
            signers: [taker]
          });
        },
        (err) => {
          return err.logs.includes("Program log: Error: Account not associated with this Mint");
        }
      );
    })

    it("Exchange", async () => {
      let makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let stateBeforeEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      let vaultBeforeEscrow = await provider.connection.getAccountInfo(escrowVault);

      let transactionSignature = await program.rpc.exchange(new anchor.BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: takerTokenAccountB,
          toTakerAccount: takerTokenAccountA,
          maker: maker.publicKey,
          toMakerAccount: makerTokenAccountB,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          // TODO Can we avoid passing in the system program?
          systemProgram: anchor.web3.SystemProgram.programId
        },
        signers: [taker]
      });

      // await provider.connection.confirmTransaction(
      //   transactionSignature,
      //   "confirmed"
      // );
      // let transaction = await provider.connection.getParsedConfirmedTransaction(transactionSignature, "confirmed");
      // console.dir(transactionMetada);

      let _makerTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);
      let _makerTokenAccountB = await mintB.getAccountInfo(makerTokenAccountB);

      let _takerTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);
      let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);

      let makerAfterEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let stateAfterEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      let vaultAfterEscrow = await provider.connection.getAccountInfo(escrowVault);

      // Check that the maker gets back ownership of their token account.
      assert.deepEqual(_makerTokenAccountA.owner, maker.publicKey);
      assert.equal(_makerTokenAccountA.amount.toNumber(), 0);
      assert.equal(_makerTokenAccountB.amount.toNumber(), takerAmount);
      assert.equal(_takerTokenAccountA.amount.toNumber(), makerAmount);
      assert.equal(_takerTokenAccountB.amount.toNumber(), 0);

      // TODO Check that the rent of the escrowState went back to maker
      // TODO Assert that there was a transaction fee
      // let before = makerBeforeEscrow.lamports + stateBeforeEscrow.lamports + vaultBeforeEscrow.lamports;
      // let after = makerAfterEscrow.lamports;
      // console.log("Balances", before, after, after - before);

      // Check that escrowState and vault account is gone
      assert.equal(stateAfterEscrow, null);
      assert.equal(vaultAfterEscrow, null);
    });

    it("Cancel", async () => {
      // Put back tokens into maker token A account.
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      await mintA.mintTo(
        makerTokenAccountA,
        mintAuthority.publicKey,
        [mintAuthority],
        newMakerAmount
      );

      await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(newMakerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenAccountA,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      // Cancel the escrow.
      await program.rpc.cancel(new anchor.BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: makerTokenAccountA,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [maker],
      });

      let _makerTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);

      // Check all the funds were sent back there.
      assert.ok(_makerTokenAccountA.amount.toNumber() == newMakerAmount);

      // TODO Check that escrowState and escrowVault accounts are gone
    });

    it("Target Taker should be checked", async () => {
      // Put back tokens into maker token A account.
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 2;
      await mintA.mintTo(
        makerTokenAccountA,
        mintAuthority.publicKey,
        [mintAuthority],
        newMakerAmount
      );

      await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(newMakerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          // NOTE The maker is set to be the only pubkey allowed to exchange
          targetTaker: maker.publicKey
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenAccountA,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );
      // Try to execute the escrow
      assert.rejects(
        program.rpc.exchange(new anchor.BN(vaultBump), {
          accounts: {
            // This taker won't match the targetTaker set above
            taker: taker.publicKey,
            fromTakerAccount: takerTokenAccountB,
            toTakerAccount: takerTokenAccountA,
            maker: maker.publicKey,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            // TODO Can we avoid passing in the system program?
            systemProgram: anchor.web3.SystemProgram.programId
          },
          signers: [taker]
        }),
        (err) => {
          return err.logs.includes("target_taker in escrow_state does not match taker");
        }
      )

      // Make sure the escrow vault + state are released
      await program.rpc.exchange(new anchor.BN(vaultBump), {
        accounts: {
          // This taker won't match the targetTaker set above
          taker: maker.publicKey,
          fromTakerAccount: makerTokenAccountB,
          toTakerAccount: makerTokenAccountA,
          maker: maker.publicKey,
          toMakerAccount: makerTokenAccountB,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          // TODO Can we avoid passing in the system program?
          systemProgram: anchor.web3.SystemProgram.programId
        },
        signers: [maker]
      });

    });
  });

  describe("SolSpl trade", () => {
    const makerAmountLamports = makerAmount * LAMPORTS_PER_SOL;

    it("Initialize", async () => {
      let _makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let transactionSignature = await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(makerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      let _maker = await provider.connection.getAccountInfo(maker.publicKey);
      let _escrowVault = await provider.connection.getAccountInfo(escrowVault);
      let _escrowStateAccount = await provider.connection.getAccountInfo(escrowState.publicKey);
      let _escrowState = await program.account.escrowState.fetch(escrowState.publicKey);


      // Check that the maker gave the amount, and paid for the escrowState
      assert.equal(_maker.lamports, _makerBeforeEscrow.lamports - makerAmountLamports - _escrowStateAccount.lamports);

      // Check that the vault holds the makerAmount
      assert.equal(_escrowVault.lamports, makerAmountLamports);

      // Check that the values in the escrow account match what we expect.
      assert.ok(_escrowState.maker.equals(maker.publicKey));
      assert.equal(_escrowState.makerAmount.toNumber(), makerAmount);
      assert.equal(_escrowState.takerAmount.toNumber(), takerAmount);
      assert.ok(_escrowState.trade.solSpl.fromNative.equals(maker.publicKey));
      assert.ok(_escrowState.trade.solSpl.toToken.equals(makerTokenAccountB));
      assert.ok(_escrowState.trade.solSpl.toMint.equals(mintB.publicKey));
      assert.ok(_escrowState.vault.equals(escrowVault))
    });

    it("Invalid Exchange", async () => {
      let mintC = await Token.createMint(
        provider.connection,
        maker,
        mintAuthority.publicKey,
        null,
        0,
        TOKEN_PROGRAM_ID
      );

      let takerTokenAccountC = await mintC.createAccount(taker.publicKey);

      await mintC.mintTo(
        takerTokenAccountC,
        mintAuthority.publicKey,
        [mintAuthority],
        takerAmount
      );

      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        async () => {
          await program.rpc.exchange(new anchor.BN(vaultBump), {
            accounts: {
              taker: taker.publicKey,
              fromTakerAccount: takerTokenAccountC,
              toTakerAccount: taker.publicKey,
              maker: maker.publicKey,
              toMakerAccount: makerTokenAccountB,
              escrowVault: escrowVault,
              escrowState: escrowState.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId
            },
            signers: [taker]
          });
        },
        (err) => {
          // console.error(err);
          return err.logs.includes("Program log: Error: Account not associated with this Mint");
        }
      );
    })

    it("Exchange", async () => {
      // TODO Move these mints to a test setup
      await mintB.mintTo(
        takerTokenAccountB,
        mintAuthority.publicKey,
        [mintAuthority],
        takerAmount
      );
      // TODO Rename all these partial views to "Before", "During", "After"

      let makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let takerBeforeEscrow = await provider.connection.getAccountInfo(taker.publicKey);
      let stateBeforeEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      let vaultBeforeEscrow = await provider.connection.getAccountInfo(escrowVault);
      let makerBeforeEscrowTokenAccountB = await mintB.getAccountInfo(makerTokenAccountB);

      assert.equal(vaultBeforeEscrow.lamports, makerAmountLamports);

      // console.log(
      //   "transfer from ",
      //   escrowVault.toString(),
      //   " owner: ",
      //   vaultBeforeEscrow.owner.toString(),
      //   " --- to --- ",
      //   taker.publicKey.toString(),
      //   " owner: ",
      //   takerBeforeEscrow.owner.toString()
      // );
      let transactionSignature = await program.rpc.exchange(new anchor.BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: takerTokenAccountB,
          toTakerAccount: taker.publicKey,
          maker: maker.publicKey,
          toMakerAccount: makerTokenAccountB,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          // TODO Can we avoid passing in the system program?
          systemProgram: anchor.web3.SystemProgram.programId
        },
        signers: [taker]
      });

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );
      const transaction = await provider.connection.getParsedConfirmedTransaction(transactionSignature, "confirmed");

      let _maker = await provider.connection.getAccountInfo(maker.publicKey);
      let makerAfterEscrowTokenAccountB = await mintB.getAccountInfo(makerTokenAccountB);

      let takerAfterEscrow = await provider.connection.getAccountInfo(taker.publicKey);
      let takerAfterTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);

      let makerAfterEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let stateAfterEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      let vaultAfterEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);

      // Maker gets escrowState rent
      assert.equal(makerAfterEscrow.lamports, makerBeforeEscrow.lamports + stateBeforeEscrow.lamports);
      // Maker gets takerAmount of TokenB
      assert.equal(makerAfterEscrowTokenAccountB.amount.toNumber(), makerBeforeEscrowTokenAccountB.amount.toNumber() + takerAmount);
      // Taker gets escrowVault lamports
      assert.equal(takerAfterEscrow.lamports, takerBeforeEscrow.lamports + makerAmountLamports);
      // Taker loses takerAmount of TokenB
      assert.equal(takerAfterTokenAccountB.amount.toNumber(), 0);

      // TODO Assert that there was a transaction fee

      // Check that escrowState and escrowVault accounts are gone
      assert.equal(stateAfterEscrow, null);
      assert.equal(vaultAfterEscrow, null);
    });

    it("Cancel", async () => {
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      let newMakerAmountLamports = newMakerAmount * LAMPORTS_PER_SOL;

      let _makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);

      await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(newMakerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let _makerDuringEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let _vaultDuringEscrow = await provider.connection.getAccountInfo(escrowVault);
      let _stateDuringEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);

      assert.equal(_makerDuringEscrow.lamports, _makerBeforeEscrow.lamports - _stateDuringEscrow.lamports - _vaultDuringEscrow.lamports);
      assert.equal(_vaultDuringEscrow.lamports, newMakerAmountLamports);

      // Cancel the escrow.
      await program.rpc.cancel(new anchor.BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [maker],
      });

      let _makerAfterCancel = await provider.connection.getAccountInfo(maker.publicKey);

      // Check all the funds were sent back there.
      assert.equal(_makerBeforeEscrow.lamports, _makerAfterCancel.lamports);

      // TODO Check that the rent of the escrowState went back to maker
    });
  });

  describe("SplSol trade", () => {
    const takerAmountLamports = takerAmount * LAMPORTS_PER_SOL;

    it("Initialize", async () => {
      let _makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let transactionSignature = await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(makerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenAccountA,
            toMakerAccount: maker.publicKey,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      let _maker = await provider.connection.getAccountInfo(maker.publicKey);
      let _escrowVaultAccount = await provider.connection.getAccountInfo(escrowVault);
      let _escrowVault = await mintA.getAccountInfo(escrowVault);
      let _escrowStateAccount = await provider.connection.getAccountInfo(escrowState.publicKey);
      let _escrowState = await program.account.escrowState.fetch(escrowState.publicKey);


      // Check that the maker gave the amount, and paid for the escrowState
      assert.equal(_maker.lamports, _makerBeforeEscrow.lamports - _escrowStateAccount.lamports - _escrowVaultAccount.lamports);

      // Check that the vault holds the makerAmount of Token A
      assert.equal(_escrowVault.amount, makerAmount);

      // Check that the values in the escrow account match what we expect.
      assert.ok(_escrowState.maker.equals(maker.publicKey));
      assert.equal(_escrowState.makerAmount.toNumber(), makerAmount);
      assert.equal(_escrowState.takerAmount.toNumber(), takerAmount);
      assert.ok(_escrowState.trade.splSol.toNative.equals(maker.publicKey));
      assert.ok(_escrowState.trade.splSol.fromToken.equals(makerTokenAccountA));
      assert.ok(_escrowState.trade.splSol.fromMint.equals(mintA.publicKey));
      assert.ok(_escrowState.vault.equals(escrowVault))
    });

    it("Invalid Exchange", async () => {
      let mintC = await Token.createMint(
        provider.connection,
        maker,
        mintAuthority.publicKey,
        null,
        0,
        TOKEN_PROGRAM_ID
      );

      let takerTokenAccountC = await mintC.createAccount(taker.publicKey);

      await mintC.mintTo(
        takerTokenAccountC,
        mintAuthority.publicKey,
        [mintAuthority],
        takerAmount
      );

      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        async () => {
          await program.rpc.exchange(new anchor.BN(vaultBump), {
            accounts: {
              taker: taker.publicKey,
              fromTakerAccount: taker.publicKey,
              toTakerAccount: takerTokenAccountC, // NOTE This is the wrong account, it should hold lamports
              maker: maker.publicKey,
              toMakerAccount: maker.publicKey,
              escrowVault: escrowVault,
              escrowState: escrowState.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId
            },
            signers: [taker]
          });
        },
        (err) => {
          // console.error(err);
          return err.logs.includes("Program log: Error: Account not associated with this Mint");
        }
      );
    })

    it("Exchange", async () => {
      // TODO Rename all these partial views to "Before", "During", "After"

      const makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      const takerBeforeEscrow = await provider.connection.getAccountInfo(taker.publicKey);
      const stateAccountBeforeEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      const vaultAccountBeforeEscrow = await provider.connection.getAccountInfo(escrowVault);

      const vaultBeforeEscrow = await mintA.getAccountInfo(escrowVault);
      const makerBeforeEscrowTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);
      const takerBeforeTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);

      assert.equal(vaultBeforeEscrow.amount, makerAmount);

      let transactionSignature = await program.rpc.exchange(new anchor.BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: taker.publicKey,
          toTakerAccount: takerTokenAccountA,
          maker: maker.publicKey,
          toMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          // TODO Can we avoid passing in the system program?
          systemProgram: anchor.web3.SystemProgram.programId
        },
        signers: [taker]
      });

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );
      // const transaction = await provider.connection.getParsedConfirmedTransaction(transactionSignature, "confirmed");

      const takerAfterEscrow = await provider.connection.getAccountInfo(taker.publicKey);
      const makerAfterEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      const stateAfterEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);
      const vaultAfterEscrow = await provider.connection.getAccountInfo(escrowVault);

      const makerAfterEscrowTokenAccountA = await mintA.getAccountInfo(makerTokenAccountA);
      const takerAfterTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);

      // Maker gets escrowState rent + escrowVault rent
      assert.equal(makerAfterEscrow.lamports, makerBeforeEscrow.lamports + stateAccountBeforeEscrow.lamports + vaultAccountBeforeEscrow.lamports + takerAmountLamports);

      // Taker gets makerAmount of TokenA
      assert.equal(takerAfterTokenAccountA.amount.toNumber(), takerBeforeTokenAccountA.amount.toNumber() + makerAmount);
      // Taker loses takerAmountLamports lamports
      assert.equal(takerAfterEscrow.lamports, takerBeforeEscrow.lamports - takerAmountLamports);

      // TODO Assert that there was a transaction fee
      // Check that escrowState and escrowVault accounts are gone
      assert.equal(stateAfterEscrow, null);
      assert.equal(vaultAfterEscrow, null);
    });

    it("Cancel", async () => {
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      let newMakerAmountLamports = newMakerAmount * LAMPORTS_PER_SOL;

      let _makerBeforeEscrow = await provider.connection.getAccountInfo(maker.publicKey);

      await program.rpc.initialize(
        {
          makerAmount: new anchor.BN(newMakerAmount),
          takerAmount: new anchor.BN(takerAmount),
          vaultBump: new anchor.BN(vaultBump),
          targetTaker: null
        },
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenAccountB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let _makerDuringEscrow = await provider.connection.getAccountInfo(maker.publicKey);
      let _vaultDuringEscrow = await provider.connection.getAccountInfo(escrowVault);
      let _stateDuringEscrow = await provider.connection.getAccountInfo(escrowState.publicKey);

      assert.equal(_makerDuringEscrow.lamports, _makerBeforeEscrow.lamports - _stateDuringEscrow.lamports - _vaultDuringEscrow.lamports);
      assert.equal(_vaultDuringEscrow.lamports, newMakerAmountLamports);

      // Cancel the escrow.
      await program.rpc.cancel(new anchor.BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [maker],
      });

      let _makerAfterCancel = await provider.connection.getAccountInfo(maker.publicKey);

      // Check all the funds were sent back there.
      assert.equal(_makerBeforeEscrow.lamports, _makerAfterCancel.lamports);

      // TODO Check that the rent of the escrowState went back to maker
    });
  })
});
