/* eslint-disable no-sync */

const path = require( 'path' );
const https = require( 'https' );
const url = require( 'url' );
const fs = require( 'fs' );

const mustache = require( 'mustache' );
const postcss = require( 'postcss' );
const cssnano = require( 'cssnano' );
const AWS = require( 'aws-sdk' );
const junk = require( 'junk' );
const mime = require( 'mime-types' );
const recursive = require( 'recursive-readdir' );

require( 'dotenv' ).config();

if ( !process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY ) {
    throw new Error( 'AWS auth not configured' );
}

if ( !process.env.API_TOKEN ) {
    throw new Error( 'Unable to load api key' );
}

const S3_BUCKET = 'developer-tracker';
const API_HOST = 'api.kokarn.com';
// const API_HOST = 'localhost:3000';
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const s3 = new AWS.S3( {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
} );

const cacheControls = [
    {
        match: 'service-worker.js',
        cache: 'public, max-age=600, must-revalidate',
    },
    {
        match: '.*\.html',
        cache: 'public, max-age=600',
    },
    {
        match: '.*\.css',
        cache: 'public, max-age=31536000',
    },
    {
        match: '.*\.js',
        cache: 'public, max-age=31536000',
    },
    {
        match: '\.(jpg|jpeg|gif|png|ico|cur|gz|svg|svgz|mp4|ogg|ogv|webm|htc|woff|woff2)',
        cache: 'public, max-age=2678400',
    },
    {
        match: '\.(json|xml)',
        cache: 'public, max-age=2678400',
    },
];

const promiseGet = function promiseGet( requestUrl, headers = false ) {
    return new Promise( ( resolve, reject ) => {
        let httpsGet = requestUrl;
        if ( headers ) {
            const urlParts = url.parse( requestUrl );

            httpsGet = {
                headers: headers,
                hostname: urlParts.hostname,
                path: urlParts.path,
                port: urlParts.port || 443,
            };
        }

        console.log( `Loading ${ requestUrl }` );

        const request = https.get( httpsGet, ( response ) => {
            if ( response.statusCode < 200 || response.statusCode > 299 ) {
                reject( new Error( `Failed to load ${ requestUrl }, status code: ${ response.statusCode }` ) );
            }

            const body = [];

            console.log( `Done with ${ requestUrl }` );

            response.on( 'data', ( chunk ) => {
                body.push( chunk );
            } );

            response.on( 'end', () => {
                resolve( body.join( '' ) );
            } );
        } );

        request.on( 'error', ( requestError ) => {
            reject( requestError );
        } );
    } );
};

const getGames = async function getGames() {
    let allGamesConfig;
    const gamesConfig = {};

    try {
        const gamesConfigResponse = await promiseGet( `https://${ API_HOST }/games`, {
            Authorization: `Bearer ${ process.env.API_TOKEN }`,
        } );
        allGamesConfig = JSON.parse( gamesConfigResponse );
    } catch ( getGamesError ) {
        console.log( `Unable to load games. Got "${ getGamesError.message }"` );

        throw getGamesError;
    }

    allGamesConfig.data.forEach( ( gameConfig ) => {
        gamesConfig[ gameConfig.identifier ] = gameConfig;
    } );

    return gamesConfig;
};

const getCache = function getCache ( filePath ) {
    const filename = path.parse( filePath ).base;

    for ( const cacheSetup of cacheControls ) {
        const regex = new RegExp( cacheSetup.match );

        if ( regex.test( filePath ) ) {
            return cacheSetup.cache;
        }
    }

    console.error( `No cache for ${ filename }` );

    return false;
};

const uploadFile = function uploadFile( filePath, fileData ) {
    const params = {
        Bucket: S3_BUCKET,
        Key: filePath,
        Body: fileData,
        CacheControl: getCache( filePath ),
        ContentType: mime.lookup( filePath ),
    };

    s3.putObject( params, ( uploadError, data ) => {
        if ( uploadError ) {
            console.error( uploadError )
        } else {
            console.log( `Successfully uploaded ${ filePath } to ${ S3_BUCKET }` );
        }
    } );
};

const buildGame = function buildGame( gameData ) {
    console.log( `Building ${ gameData.identifier }` );
    const gameFilesPath = path.join( __dirname, '..', 'games', gameData.identifier );
    const rewriteFiles = [
        'index.html',
        'service-worker.js',
    ];
    const dataRootPath = path.join( __dirname, '..', 'web' );

    // Upload all default files
    recursive( dataRootPath, ( readDirError, files ) => {
        if ( readDirError ) {
            throw readDirError;
        }

        fileLoop:
        for ( const file of files ) {
            if ( junk.is( path.parse( file ).base ) ) {
                continue;
            }
            const fileName = path.join( gameData.identifier, file.replace( dataRootPath, '' ) )

            // Don't upload files we'll rewrite
            for ( const rewriteFile of rewriteFiles ) {
                if ( fileName.includes( rewriteFile ) ) {
                    continue fileLoop;
                }
            }

            uploadFile( fileName, fs.readFileSync( file ) );
        }
    } );

    uploadFile( path.join( gameData.identifier, '/assets/styles.min.css' ), gameData.builtStyles );

    recursive( gameFilesPath, ( gameFilesError, gameFiles ) => {
        if ( gameFilesError ) {
            console.log( `No game files found for ${ gameData.identifier } ` );
            gameFiles = [];
        }

        for ( const filename of gameFiles ) {
            if ( junk.is( path.parse( filename ).base ) ) {
                continue;
            }

            if ( filename.includes( 'styles.css' ) ) {
                gameData.styles = fs.readFileSync( filename );
            }

            if ( filename.includes( 'assets/logo.png' ) ) {
                gameData.logo = '<img src="assets/logo.png" class="header-logo">';
            }

            uploadFile( path.join( gameData.identifier, filename.replace( gameFilesPath, '' ) ), fs.readFileSync( filename ) );
        }

        if ( !gameData.logo ) {
            gameData.logo = gameData.shortName;
        }

        for ( let i = 0; i < rewriteFiles.length; i = i + 1 ) {
            // Fill in the data where needed
            fs.readFile( path.join( dataRootPath, rewriteFiles[ i ] ), 'utf8', ( readFileError, fileData ) => {
                if ( readFileError ) {
                    console.error( readFileError );

                    return false;
                }

                uploadFile( path.join( gameData.identifier, rewriteFiles[ i ] ), mustache.render( fileData, gameData ) );

                return true;
            } );
        }
    } );

    console.log( `Build ${ gameData.identifier } done` );
};

const buildAllGames = function buildAllGames( gamesData ){
    const allGamesTemplate = fs.readFileSync( path.join( __dirname, '..', 'web-assets', 'games-template.html' ), 'utf8' );
    const games = Object.values( gamesData );
    const renderData = {
        games: [],
    };

    games.sort( ( a, b ) => {
        return a.name.localeCompare( b.name );
    } );

    for ( let i = 0; i < games.length; i = i + 1 ) {
        // Don't build games set as not live
        if ( !games[ i ].config || games[ i ].config.live === 0 || games[ i ].config.live === false ) {
            continue;
        }

        let name = games[ i ].name;
        let url = games[ i ].hostname;
        let image = games[ i ].config.boxart;

        if ( url === 'developertracker.com' ) {
            url = `${ url }/${ games[ i ].identifier }/`
        }

        renderData.games.push( {
            url,
            image,
            name,
        } );
    }

    uploadFile( 'index.html', mustache.render( allGamesTemplate, renderData ) );
};

const run = async function run() {
    let games;

    try {
        games = await getGames();
    } catch ( loadGamesError ) {
        console.error( 'Failed to load games from the API, not building' );

        return false;
    }
    const addGameProperty = function addGameProperty( property, value ) {
        for ( const identifier in games ) {
            games[ identifier ][ property ] = value;
        }
    };
    const polyfills = fs.readFileSync( path.join( __dirname, '/../web-assets/polyfills.js' ), 'utf8' );
    addGameProperty( 'polyfills', polyfills );

    // Styles
    const generalStyles = fs.readFileSync( path.join( __dirname, '/../web-assets/bootswatch.css' ), 'utf8' );
    const trackerStyles = fs.readFileSync( path.join( __dirname, '/../web-assets/styles.css' ), 'utf8' );
    const globalStyles = `${ generalStyles }\n${ trackerStyles }`;

    addGameProperty( 'version', Date.now() );

    const servicePromises = [];

    for ( const identifier in games ) {
        const servicePromise = promiseGet( `https://${ API_HOST }/${ identifier }/services` )
            .then( ( servicesResponse ) => {
                let services = JSON.parse( servicesResponse ).data;

                // If we only have one service, treat it as none
                if ( services.length === 1 ) {
                    services = [];
                }

                // Transform service names to objects
                services = services.map( ( name ) => {
                    let label = name;
                    if ( games[ identifier ].config && games[ identifier ].config.sources && games[ identifier ].config.sources[ name ] ) {
                        label = games[ identifier ].config.sources[ name ].label || name;
                    }

                    return {
                        active: true,
                        name: name,
                        label: label,
                    };
                } );

                services.sort( ( a,b ) => {
                    return a.label.localeCompare( b.label );
                } );

                games[ identifier ].services = JSON.stringify( services );
            } )
            .catch( ( serviceError ) => {
                throw serviceError;
            } );

        servicePromises.push( servicePromise );
    }

    const groupPromises = [];

    for ( const identifier in games ) {
        const groupPromise = promiseGet( `https://${ API_HOST }/${ identifier }/groups` )
            .then( ( groupsResponse ) => {
                let groups = JSON.parse( groupsResponse ).data;

                // If we only have one group, treat it as none
                if ( groups.length === 1 ) {
                    groups = [];
                }

                // Transform group names to objects
                groups = groups.map( ( name ) => {
                    return {
                        active: true,
                        name: name,
                    };
                } );

                games[ identifier ].groups = JSON.stringify( groups );
            } )
            .catch( ( groupError ) => {
                throw groupError;
            } );

        groupPromises.push( groupPromise );
    }

    postcss( [ cssnano ] )
        .process( globalStyles )
        .then( ( result ) => {
            addGameProperty( 'builtStyles', result.css );
        } )
        .then( () => {
            // Wait for a bunch of promises
            return Promise.all( [
                Promise.all( servicePromises ),
                Promise.all( groupPromises ),
            ] );
        } )
        .then( () => {
            for ( const gameIdentifier in games ) {
                buildGame( games[ gameIdentifier ] );
            }

            buildAllGames( games );
        } )
        .catch( ( chainError ) => {
            throw chainError;
        } );
};

run();
