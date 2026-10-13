# Istinto Puro

Scegli due o più squadre di calcio (club o nazionali) e scopri quali calciatori hanno giocato in tutte, con gli anni passati in ciascuna.

## Come funziona

- **Squadre**: `public/teams.json` contiene circa 12.800 club e nazionali presi da Wikidata, con nomi italiani, alias e stemmi. I suggerimenti si cercano direttamente nel browser: sono istantanei e non fanno richieste in rete.
- **Giocatori, prima fonte**: una query SPARQL a [Wikidata](https://query.wikidata.org) (proprietà P54 "squadra di appartenenza", con gli anni dai qualificatori P580/P582). Le squadre rifondate (es. Vicenza Calcio e L.R. Vicenza) contano come una sola.
- **Giocatori, seconda fonte**: Wikidata a volte ha carriere incomplete. Subito dopo, l'app cerca su Wikipedia italiana le voci che linkano tutte le squadre, tiene i candidati più probabili e ne legge il riquadro della carriera (50 voci per richiesta). I giocatori trovati così sono segnati "da Wikipedia".
- I risultati restano in cache nel browser per 3 giorni.
- **Modalità gioco**: "Nascondi nomi" copre i giocatori. Scrivendo un nome in "Controlla un nome" vedi se la risposta è valida senza scoprire gli altri.
- Il link contiene le squadre scelte (`?squadre=Q1422,Q2641`), quindi si può condividere.

Non servono server o chiavi API: è un sito statico.

## Sviluppo

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # test su ricerca squadre e lettura dei dati
npm run build    # sito statico in dist/
```

Per aggiornare l'elenco delle squadre (ogni qualche mese basta):

```bash
npm run teams
```

## Limiti noti

- I dati dipendono da Wikidata e Wikipedia italiana: giocatori di serie minori o senza voce su Wikipedia possono mancare, e a volte mancano gli anni.
- Con squadre che hanno moltissimi giocatori in comune, su Wikipedia si controllano i primi 500 candidati.
- Prima squadra, giovanili, squadra B e femminile sono voci separate.
