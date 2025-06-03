if [ -z "$1" ]; then
  echo "Error: STAGE argument is required"
  echo "Usage: $0 <stage>"
  exit 1
fi

STAGE=$1

echo "Creating keys for stage: $STAGE"

echo "Creating private key..."
openssl genpkey \
  -algorithm RSA \
  -out private.key \
  -pkeyopt rsa_keygen_bits:2048

echo "Creating public key..."
openssl rsa \
  -in private.key \
  -pubout \
  -out public.key

echo "Creating public key secret..."
aws secretsmanager create-secret \
  --name cloudfront-signing-publickey-$STAGE \
  --secret-string file://public.key \
  --no-cli-pager \
  --description "Cloudfront signing public key for animl-images-serving-$STAGE"

echo "Creating private key secret..."
aws secretsmanager create-secret \
  --name cloudfront-signing-privatekey-$STAGE \
  --secret-string file://private.key \
  --no-cli-pager \
  --description "Cloudfront signing private key for animl-images-serving-$STAGE"
