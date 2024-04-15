import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import encoding from 'k6/encoding';

export let encryptErrors = new Rate('encrypt_errors');
export let decryptErrors = new Rate('decrypt_errors');
export let encryptDecryptErrors = new Rate('encrypt_decrypt_errors');
export let encryptTimeouts = new Rate('encrypt_timeouts');
export let decryptTimeouts = new Rate('decrypt_timeouts');
export let encryptTime = new Trend("encrypt_time")
export let decryptTime = new Trend("decrypt_time")

const sleepDuration = __ENV.SLEEP_DURATION ? Number(__ENV.SLEEP_DURATION) / 1000 : null;


// To disable the certificate verification
export const options = {
    insecureSkipTLSVerify: JSON.parse(__ENV.SKIP_TLS_VERIFICATION.toLowerCase()),
}

/*
* Function to get the signed data from crypto function
* This signed data is used to generate hyok header signature
* */
function sign(key, msg, hex_digest = false, digest_without_key = false) {
    var digest = null
    if (digest_without_key == true) {
        if (hex_digest == true) {
            digest = crypto.sha256(msg, 'hex')
        } else {
            digest = crypto.sha256(msg, 'binary')
        }
    } else {
        if (hex_digest == true) {
            digest = crypto.hmac('sha256', key, msg, 'hex')
        } else {
            digest = crypto.hmac('sha256', key, msg, 'binary')
        }
    }

    return digest
}

/* Function to get the signing key using access secret key, date and region */
function getSigningKey(key, datestamp, region, service) {
    var key_date = sign(`AWS4${key.toString()}`, datestamp)
    var key_region = sign(key_date, region)
    var key_service = sign(key_region, service)
    var key_signing = sign(key_service, 'aws4_request')

    return key_signing
}

/* Funciton to generate the signed header for hyok crypto operations*/
function generateHeader(dict, op) {
    var algorithm = 'AWS4-HMAC-SHA256'
    var xks_service = 'kms-xks-proxy'
    var request_type = 'aws4_request'

    // Get the UTC time year, month, date etc
    const d = new Date()
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth()
    const date = d.getUTCDate()
    const hour = d.getHours()
    const mins = d.getUTCMinutes()
    const sec = d.getUTCSeconds()
    const millisec = d.getUTCMilliseconds()

    /* if year, date, month etc are less than 10 then 0 will appended e.g
       month is 5 then it will become 05
       In java script UTC months are returned as an array and it starts from
       index 0 so we are adding 1 to get the current month. e.g if current
       month is may so UTC month will return 4 so we have to add 1 to get
       the current months value
     */
    const hyok_date = year.toString() + (month < 10 ? '0' : '') + (month + 1).toString() + (date < 10 ? `0${date}` : date.toString()) + "T" + (hour < 10 ? `0${hour}` : hour.toString()) + (mins < 10 ? `0${mins}` : mins.toString()) + (sec < 10 ? `0${sec}` : sec.toString()) + "Z"
    var hyok_date_stamp = year.toString() + (month < 10 ? '0' : '') + (month + 1).toString() + (date < 10 ? `0${date}` : date.toString())
    var headers_to_sign = { 'host': dict["kylo"], 'x-amz-date': hyok_date }

    var crypto_url = dict["xks_proxy_uri"] + "/keys/" + dict["hyok_key_id"] + "/" + op
    var canonical_headers = ""

    for (var header in headers_to_sign) {
        canonical_headers = canonical_headers + header + ":" + headers_to_sign[header] + "\n"
    }

    var signed_header = ""
    for (var header in headers_to_sign) {
        signed_header = signed_header + ";" + header
    }
    signed_header = signed_header.replace(";", '')
    var payload = dict['payload']
    var payload_hash = sign(null, payload, true, true)
    var canonical_query_string = ""
    var canonical_request = `POST\n${crypto_url}\n${canonical_query_string}\n${canonical_headers}\n${signed_header}\n${payload_hash}`
    var canonical_request_hash = sign(null, canonical_request, true, true)

    var credential_scope = `${hyok_date_stamp}/${__ENV.AWS_REGION}/${xks_service}/${request_type}`
    var string_to_sign = `${algorithm}\n${hyok_date}\n${credential_scope}\n${canonical_request_hash}`
    var signing_key = getSigningKey(dict["cks_access_secret_key"], hyok_date_stamp, __ENV.AWS_REGION, xks_service)

    var signature = sign(signing_key, string_to_sign, true)

    var authorization_header = `${algorithm} Credential=${dict["cks_access_id"]}/${credential_scope}, SignedHeaders=${signed_header}, Signature=${signature}`

    var aws_hyok_header = {
        "Content-Type": "application/json",
        "X-Amz-Date": hyok_date,
        "Authorization": authorization_header
    }
    return aws_hyok_header
}

function encrypt(plain_text, aad_data) {
    var aws_acc_id = __ENV.AWS_ACCOUNT_ID
    var aws_user = "Alice"
    var aws_region = __ENV.AWS_REGION
    var aws_key_id = "1234abcd-12ab-34cd-56ef-1234567890ab"
    var payload = `{
        "requestMetadata": {
            "awsPrincipalArn": "arn:aws:iam::${aws_acc_id}:user/${aws_user}",
            "kmsKeyArn": "arn:aws:kms:${aws_region}:${aws_acc_id}:/key/${aws_key_id}",
            "kmsOperation": "Encrypt",
            "kmsRequestId": "${uuidv4()}",
            "kmsViaService": "ebs"
        },
        "additionalAuthenticatedData": "${aad_data}",
        "plaintext": "${plain_text}",
        "encryptionAlgorithm": "AES_GCM"
    }`

    let hyok_dict = {
        "kylo": __ENV.CM_URL,
        'xks_proxy_uri': `/api/v1/cckm/aws/xks-proxy-endpoints/${__ENV.CKS_ID}/kms/xks/v1`,
        'hyok_key_id': __ENV.HYOK_KEY_ID,
        "payload": payload,
        "cks_access_secret_key": __ENV.CKS_SECRET_KEY,
        "cks_access_id": __ENV.CKS_ACCESS_ID,
    }

    var url = `https://${__ENV.CM_URL}/api/v1/cckm/aws/xks-proxy-endpoints/${__ENV.CKS_ID}/kms/xks/v1/keys/${__ENV.HYOK_KEY_ID}/encrypt`
    var header_dict = generateHeader(hyok_dict, "encrypt")
    var params = {
        headers: {
            'Content-Type': 'application/json',
            'X-Amz-Date': header_dict['X-Amz-Date'],
            'Authorization': header_dict['Authorization']
        },
    }
    let res = http.post(url, payload, params)
    return res
}

function decrypt(ciphertext, aad_data, iv, tag, metadata) {
    var aws_acc_id = __ENV.AWS_ACCOUNT_ID
    var aws_user = "Alice"
    var aws_region = __ENV.AWS_REGION
    var aws_key_id = "1234abcd-12ab-34cd-56ef-1234567890ab"
    var payload = `{
        "requestMetadata": {
            "awsPrincipalArn": "arn:aws:iam::${aws_acc_id}:user/${aws_user}",
            "kmsKeyArn": "arn:aws:kms:${aws_region}:${aws_acc_id}:/key/${aws_key_id}",
            "kmsOperation": "Decrypt",
            "kmsRequestId": "${uuidv4()}",
            "kmsViaService": "ebs"
        },
        "additionalAuthenticatedData": "${aad_data}",
        "ciphertext": "${ciphertext}",
        "initializationVector": "${iv}",
        "authenticationTag": "${tag}",
        "ciphertextMetadata": "${metadata}",
        "encryptionAlgorithm": "AES_GCM"
    }`

    let hyok_dict = {
        "kylo": __ENV.CM_URL,
        'xks_proxy_uri': `/api/v1/cckm/aws/xks-proxy-endpoints/${__ENV.CKS_ID}/kms/xks/v1`,
        'hyok_key_id': __ENV.HYOK_KEY_ID,
        "payload": payload,
        "cks_access_secret_key": __ENV.CKS_SECRET_KEY,
        "cks_access_id": __ENV.CKS_ACCESS_ID,
    }

    var url = `https://${__ENV.CM_URL}/api/v1/cckm/aws/xks-proxy-endpoints/${__ENV.CKS_ID}/kms/xks/v1/keys/${__ENV.HYOK_KEY_ID}/decrypt`
    var header_dict = generateHeader(hyok_dict, "decrypt")
    var params = {
        headers: {
            'Content-Type': 'application/json',
            'X-Amz-Date': header_dict['X-Amz-Date'],
            'Authorization': header_dict['Authorization']
        },
    }
    let res = http.post(url, payload, params)
    return res
}

export default function () {
    const aadBytes = crypto.randomBytes(32);
    const aadData = encoding.b64encode(aadBytes);
    const randomBytes = crypto.randomBytes(32);
    const plaintext = encoding.b64encode(randomBytes);
    const encrypt_res = encrypt(plaintext, aadData)
    encryptErrors.add(!check(encrypt_res, {
        'status code': (r) => r.status === 200,
    }))
    encryptTimeouts.add(!check(encrypt_res, {
        'response time': (r) => r.timings.duration <= 250,
    }))
    encryptTime.add(encrypt_res.timings.duration)
    const body = JSON.parse(encrypt_res.body)
    const decrypt_res = decrypt(
        body.ciphertext,
        aadData,
        body.initializationVector,
        body.authenticationTag,
        body.ciphertextMetadata,
    )
    if (sleepDuration != null) {
        sleep(sleepDuration)
    }
    decryptErrors.add(!check(decrypt_res, {
        'status code': (r) => r.status === 200,
    }))
    decryptTimeouts.add(!check(decrypt_res, {
        'response time': (r) => r.timings.duration <= 250,
    }))
    encryptDecryptErrors.add(!check(decrypt_res, {
        'correctness': (r) => JSON.parse(decrypt_res.body).plaintext == plaintext,
    }))
    decryptTime.add(decrypt_res.timings.duration)
    if (sleepDuration != null) {
        sleep(sleepDuration)
    }
};
